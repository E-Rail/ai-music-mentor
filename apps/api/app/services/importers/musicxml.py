from __future__ import annotations

import stat
import zipfile
from io import BytesIO
from pathlib import Path, PurePosixPath

from defusedxml import ElementTree as SafeET

from app import config
from app.i18n import localized, msg, say
from app.schemas.models import (NormalizedScore, ScoreDisplayMode,
                                ScoreNormalization, ScoreSourceType)
from app.services.importers.base import (ImportResult, ScoreImporter,
                                         ScoreImportError, ScoreLimitError)
from app.services.score_import import ScoreUnsupportedError, parse_musicxml


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _validate_musicxml_signature(content: bytes) -> None:
    # Standard MusicXML exports commonly include the official PUBLIC doctype.
    # DefusedXML prevents entity expansion; explicit entity declarations are rejected.
    if b"<!ENTITY" in content[:8192].upper():
        raise ScoreImportError(say("import.xmlEntities"))
    try:
        root = SafeET.fromstring(content)
    except Exception as exc:
        raise ScoreImportError(say("import.xmlInvalid")) from exc
    if _local_name(root.tag) not in {"score-partwise", "score-timewise"}:
        raise ScoreImportError(say("import.notMusicXml"))


def unpack_mxl(content: bytes) -> bytes:
    if not content.startswith(b"PK"):
        raise ScoreImportError(say("import.mxlSignature"))
    try:
        archive = zipfile.ZipFile(BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise ScoreImportError(say("import.mxlCorrupt")) from exc
    infos = archive.infolist()
    if len(infos) > 512:
        raise ScoreLimitError(say("import.mxlTooManyFiles"))
    expanded = sum(info.file_size for info in infos)
    if expanded > config.MAX_MXL_EXPANDED_BYTES:
        raise ScoreLimitError(say("import.mxlTooLarge"))
    safe_names: set[str] = set()
    for info in infos:
        path = PurePosixPath(info.filename)
        mode = (info.external_attr >> 16) & 0xFFFF
        if (path.is_absolute() or ".." in path.parts or "\\" in info.filename or
                info.flag_bits & 0x1 or stat.S_ISLNK(mode)):
            raise ScoreImportError(say("import.mxlUnsafe"))
        safe_names.add(info.filename)
    try:
        container = archive.read("META-INF/container.xml")
        root = SafeET.fromstring(container)
        rootfile = next(
            element.attrib.get("full-path", "") for element in root.iter()
            if _local_name(element.tag) == "rootfile" and element.attrib.get("full-path")
        )
    except (KeyError, StopIteration, Exception) as exc:
        raise ScoreImportError(say("import.mxlNoContainer")) from exc
    if rootfile not in safe_names or PurePosixPath(rootfile).suffix.lower() not in {".xml", ".musicxml"}:
        raise ScoreImportError(say("import.mxlBadRoot"))
    xml = archive.read(rootfile)
    if len(xml) > config.MAX_MXL_EXPANDED_BYTES:
        raise ScoreLimitError(say("import.mxlRootTooLarge"))
    _validate_musicxml_signature(xml)
    return xml


class MusicXmlImporter(ScoreImporter):
    def supports(self, filename: str, content: bytes) -> bool:
        suffix = Path(filename).suffix.lower()
        return suffix in {".xml", ".musicxml", ".mxl"}

    def import_bytes(self, filename: str, content: bytes, score_id: str,
                     normalization: ScoreNormalization | None = None) -> ImportResult:
        suffix = Path(filename).suffix.lower()
        is_mxl = suffix == ".mxl"
        xml = unpack_mxl(content) if is_mxl else content
        if not is_mxl:
            _validate_musicxml_signature(xml)
        try:
            bundle = parse_musicxml(xml, score_id)
        except ScoreUnsupportedError as exc:
            raise ScoreImportError(str(exc)) from exc
        resolved = ScoreNormalization(
            tempo=bundle.meta.tempo,
            timeSignature=bundle.meta.timeSignature,
            quantization="1/16",
            trackMapping={},
            confirmed=True,
        )
        normalized = NormalizedScore(
            scoreId=score_id,
            sourceType=ScoreSourceType.mxl if is_mxl else ScoreSourceType.musicxml,
            displayMode=ScoreDisplayMode.exact_notation,
            bundle=bundle,
            **localized(warnings=([msg("import.transposing")]
                                  if bundle.meta.writtenToSoundingSemitones else [])),
            confidence=1.0, normalization=resolved,
        )
        return ImportResult(
            normalized=normalized, source_bytes=content,
            source_suffix=suffix or ".musicxml",
            source_media_type="application/vnd.recordare.musicxml" if not is_mxl else
                              "application/vnd.recordare.musicxml+xml",
            render_bytes=xml,
        )
