"""Import a photographed or printed page of music.

The model reads the page; it never writes the score. Its note list is turned
into MusicXML by the same deterministic code that engraves a generated exercise,
and that MusicXML then goes through the ordinary MusicXML importer. So a page
read from a photo reaches the score store having passed exactly the checks a
hand-uploaded file passes, and the events the app practises against were built
here, not typed by a model.

The photo itself is kept as the source artifact. A transcription is a reading,
not a fact, and the person who uploaded it must be able to go back to the page.
"""
from __future__ import annotations

import logging
import tempfile
from dataclasses import replace
from pathlib import Path

from app import config
from app.i18n import Msg, localized, msg, say
from app.schemas.models import (NormalizedScore, ScoreDisplayMode, ScoreEvent,
                                ScoreMeta, ScoreNormalization, ScoreSourceType)
from app.services.generation.score_build import events_to_musicxml
from app.services.importers.base import (ImportResult, ScoreImporter,
                                         ScoreImportError, ScoreLimitError)
from app.services.importers.musicxml import MusicXmlImporter
from app.services.vision import PageReadError, ReadPage, VisionUnavailable, read_pages
from app.services.vision.page_reader import available as vision_available

logger = logging.getLogger(__name__)

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"}
IMAGE_MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
}
_MAGIC = {
    b"\x89PNG\r\n\x1a\n": ".png",
    b"\xff\xd8\xff": ".jpg",
}
STEP_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# Smallest note value the app will trust from a reading. Finer than a
# thirty-second is below what a photograph resolves and below what this app
# grades, so rounding there costs nothing and keeps bars from failing to add up.
GRID = 0.125


def _suffix_of(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in IMAGE_SUFFIXES or suffix == ".pdf":
        return suffix
    if content.startswith(b"%PDF-"):
        return ".pdf"
    for magic, guessed in _MAGIC.items():
        if content.startswith(magic):
            return guessed
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    return suffix


def _rasterise_pdf(content: bytes) -> list[tuple[bytes, str]]:
    try:
        import pymupdf
    except ImportError as error:  # pragma: no cover - depends on the install
        raise ScoreImportError(say("import.noPdfRenderer")) from error
    try:
        document = pymupdf.open(stream=content, filetype="pdf")
    except Exception as error:  # noqa: BLE001 - any malformed PDF lands here
        raise ScoreImportError(say("import.pdfUnreadable", detail=str(error))) from error
    with document:
        if document.needs_pass:
            raise ScoreImportError(say("import.pdfEncrypted"))
        pages = []
        for index, page in enumerate(document):
            if index >= config.VISION_MAX_PAGES:
                break
            longest = max(page.rect.width, page.rect.height) or 1
            zoom = min(4.0, config.VISION_PAGE_PIXELS / longest)
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            pages.append((pixmap.tobytes("png"), "image/png"))
    if not pages:
        raise ScoreImportError(say("import.pdfNoPages"))
    return pages


def _midi_of(step: str, alter: int, octave: int) -> int | None:
    semitone = STEP_SEMITONES.get(step)
    if semitone is None:
        return None
    pitch = (octave + 1) * 12 + semitone + alter
    return pitch if 0 <= pitch <= 127 else None


def _snap(value: float) -> float:
    return round(value / GRID) * GRID


def read_page_to_events(page: ReadPage, score_id: str,
                        beats_per_measure: float) -> tuple[list[ScoreEvent], list[str]]:
    """Turn a reading into score events, and say what had to be dropped.

    Everything rejected here is reported rather than silently repaired. A bar
    quietly padded to the right length would be a bar the student practises
    against that nobody wrote.
    """
    events: list[ScoreEvent] = []
    notes_dropped = 0
    bars_dropped = 0
    # Printed bar numbers become positions 1..N; the printed number is kept as
    # the label so the page and the app still agree (see measure_labels).
    ordered = sorted(page.measures, key=lambda measure: measure.number)
    for position, measure in enumerate(ordered, start=1):
        grouped: dict[tuple[str, float], dict] = {}
        for note in measure.notes:
            pitch = _midi_of(note.step, note.alter, note.octave)
            onset = _snap(note.onset)
            duration = _snap(note.duration)
            if (pitch is None or duration <= 0 or onset < 0
                    or onset >= beats_per_measure):
                notes_dropped += 1
                continue
            # A note may not outlast its bar: this app's timeline is per-measure.
            duration = min(duration, beats_per_measure - onset)
            key = (note.staff, onset)
            group = grouped.setdefault(key, {"pitches": set(), "duration": duration})
            group["pitches"].add(pitch)
            group["duration"] = max(group["duration"], duration)
        if not grouped:
            bars_dropped += 1
            continue
        for index, (staff, onset) in enumerate(sorted(grouped)):
            group = grouped[(staff, onset)]
            token = f"{onset:g}".replace(".", "_")
            events.append(ScoreEvent(
                eventId=f"{score_id}:{staff}:m{position}:b{token}:{index}",
                measureNo=position, onsetBeat=onset,
                absoluteBeat=(position - 1) * beats_per_measure + onset,
                durationBeat=group["duration"],
                pitches=sorted(group["pitches"]), part=staff, voice=1,
            ))
    notices: list[Msg] = []
    if notes_dropped:
        notices.append(msg("import.readNotesDropped", count=notes_dropped))
    if bars_dropped:
        notices.append(msg("import.readBarsDropped", count=bars_dropped))
    return events, notices


def _labels_of(page: ReadPage, count: int) -> list[str]:
    printed = [str(measure.number)
               for measure in sorted(page.measures, key=lambda m: m.number)]
    return printed[:count] if len(printed) >= count else []


class VisionScoreImporter(ScoreImporter):
    """Photos and PDFs, read by a multimodal model and rebuilt as a score."""

    def supports(self, filename: str, content: bytes) -> bool:
        return _suffix_of(filename, content) in IMAGE_SUFFIXES | {".pdf"}

    def import_bytes(self, filename: str, content: bytes, score_id: str,
                     normalization: ScoreNormalization | None = None) -> ImportResult:
        suffix = _suffix_of(filename, content)
        # Asked before the page is opened or rendered: with no reader configured
        # the answer is the same for every file, and the person uploading should
        # be told what is missing rather than what their file looks like.
        if not vision_available():
            raise ScoreImportError(say("import.noReader"))
        if len(content) > config.MAX_SCORE_IMAGE_BYTES:
            raise ScoreLimitError(say("import.imageTooLarge",
                                      mb=config.MAX_SCORE_IMAGE_BYTES // (1024 * 1024)))
        if suffix == ".pdf":
            pages = _rasterise_pdf(content)
            source_media_type = "application/pdf"
            source_type = ScoreSourceType.pdf
        else:
            pages = [(content, IMAGE_MEDIA_TYPES.get(suffix, "image/png"))]
            source_media_type = IMAGE_MEDIA_TYPES.get(suffix, "image/png")
            source_type = ScoreSourceType.image

        try:
            outcome = read_pages(pages, Path(filename).name)
        except VisionUnavailable as error:
            raise ScoreImportError(str(error)) from error
        except PageReadError as error:
            raise ScoreImportError(say("import.readFailed", detail=str(error))) from error
        page = outcome.page
        logger.info("score read from %s: model=%s servedBy=%s latencyMs=%d attempts=%d "
                    "bars=%d confidence=%.2f", Path(filename).name, outcome.model,
                    outcome.served_by, outcome.latency_ms, outcome.attempts,
                    len(page.measures), page.confidence)

        numerator, denominator = (int(part) for part in page.timeSignature.split("/"))
        beats_per_measure = numerator * 4.0 / denominator
        events, notices = read_page_to_events(page, score_id, beats_per_measure)
        if not events:
            raise ScoreImportError(say("import.readNothing"))
        measure_count = max(event.measureNo for event in events)
        if measure_count > config.MAX_MEASURES:
            raise ScoreLimitError(say("import.readTooManyBars", count=measure_count, limit=config.MAX_MEASURES))

        title = page.title.strip() or Path(filename).stem
        draft_meta = ScoreMeta(
            scoreId=score_id, title=title, composer=page.composer.strip(),
            tempo=page.tempo or 96.0, timeSignature=page.timeSignature,
            beatsPerMeasure=beats_per_measure, measureCount=measure_count,
        )
        with tempfile.TemporaryDirectory(prefix="music-mentor-omr-") as directory:
            xml_path = Path(directory) / "read.musicxml"
            events_to_musicxml(events, draft_meta, draft_meta.tempo, title, xml_path)
            xml = xml_path.read_bytes()

        # The reading now goes through the ordinary front door. Whatever the
        # model said, only what the MusicXML importer accepts becomes a score.
        result = MusicXmlImporter().import_bytes(
            f"{score_id}.musicxml", xml, score_id, normalization)

        labels = _labels_of(page, result.normalized.bundle.meta.measureCount)
        meta = result.normalized.bundle.meta.model_copy(update={
            "title": title, "composer": draft_meta.composer,
            **({"measureLabels": labels} if labels else {}),
        })
        bundle = result.normalized.bundle.model_copy(update={"meta": meta})
        warnings = [
            msg("import.readByModel", model=outcome.model),
            *notices,
            *[msg("import.unreadable", item=item) for item in page.unreadable[:5]],
        ]
        normalized = NormalizedScore(
            scoreId=score_id, sourceType=source_type,
            displayMode=ScoreDisplayMode.simplified_quantized_staff,
            bundle=bundle, **localized(warnings=warnings),
            # The model's own estimate, held below 0.9: no reading of a
            # photograph is as trustworthy as a file someone exported.
            confidence=max(0.2, min(0.9, page.confidence)),
            normalization=result.normalized.normalization,
        )
        return replace(
            result, normalized=normalized, source_bytes=content,
            source_suffix=suffix, source_media_type=source_media_type,
        )
