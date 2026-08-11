from __future__ import annotations

import hashlib
import statistics
import tempfile
from collections import defaultdict, deque
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import mido

from app import config
from app.schemas.models import (NormalizedScore, ScoreBundle, ScoreDisplayMode,
                                ScoreEvent, ScoreMeta, ScoreNormalization,
                                ScoreSourceType)
from app.services.generation.score_build import events_to_musicxml
from app.services.importers.base import (ImportResult, ScoreImporter,
                                         ScoreImportError, ScoreLimitError)
from app.services.midi_io import MidiFileValidationError, validate_midi_bytes


QUANTIZATION_BEATS = {
    "1/4": 1.0, "1/8": 0.5, "1/12": 1 / 3, "1/16": 0.25,
    "1/24": 1 / 6, "1/32": 0.125,
}


@dataclass
class _MidiNote:
    track: int
    channel: int
    pitch: int
    velocity: int
    start_tick: int
    end_tick: int


def _read_notes(midi: mido.MidiFile) -> tuple[list[_MidiNote], dict[int, list[int]]]:
    notes: list[_MidiNote] = []
    pitches_by_track: dict[int, list[int]] = defaultdict(list)
    for track_index, track in enumerate(midi.tracks):
        tick = 0
        active: dict[tuple[int, int], deque[tuple[int, int]]] = defaultdict(deque)
        for message in track:
            tick += message.time
            if message.type == "note_on" and message.velocity > 0:
                active[(message.channel, message.note)].append((tick, message.velocity))
                pitches_by_track[track_index].append(message.note)
            elif message.type == "note_off" or (message.type == "note_on" and message.velocity == 0):
                queue = active[(message.channel, message.note)]
                if queue:
                    start, velocity = queue.popleft()
                    notes.append(_MidiNote(track_index, message.channel, message.note,
                                           velocity, start, max(start + 1, tick)))
        for (channel, pitch), queue in active.items():
            for start, velocity in queue:
                notes.append(_MidiNote(track_index, channel, pitch, velocity,
                                       start, start + max(1, midi.ticks_per_beat // 4)))
    return notes, pitches_by_track


def _default_track_mapping(pitches_by_track: dict[int, list[int]]) -> tuple[dict[str, str], list[str], float]:
    tracks = sorted(pitches_by_track)
    warnings: list[str] = []
    if not tracks:
        return {}, warnings, 0.0
    medians = {track: statistics.median(pitches_by_track[track]) for track in tracks}
    if len(tracks) == 1:
        warnings.append("单轨 MIDI 无法可靠还原左右手；已按中央 C 自动拆分")
        return {str(tracks[0]): "split"}, warnings, 0.68
    ranked = sorted(tracks, key=lambda track: medians[track])
    midpoint = len(ranked) // 2
    mapping = {str(track): ("LH" if index < midpoint else "RH")
               for index, track in enumerate(ranked)}
    if len(tracks) > 2:
        warnings.append("检测到多个含音符轨道；请在导入复核中确认左右手映射")
    return mapping, warnings, 0.84 if len(tracks) == 2 else 0.76


def _parse_time_signature(value: str) -> tuple[int, int, float]:
    try:
        numerator_text, denominator_text = value.split("/", 1)
        numerator, denominator = int(numerator_text), int(denominator_text)
        if numerator < 1 or numerator > 32 or denominator not in {1, 2, 4, 8, 16, 32}:
            raise ValueError
    except ValueError as exc:
        raise ScoreImportError("拍号必须形如 4/4、3/4 或 6/8") from exc
    return numerator, denominator, numerator * 4.0 / denominator


class MidiScoreImporter(ScoreImporter):
    def supports(self, filename: str, content: bytes) -> bool:
        return Path(filename).suffix.lower() in {".mid", ".midi"} or content.startswith(b"MThd")

    def import_bytes(self, filename: str, content: bytes, score_id: str,
                     normalization: ScoreNormalization | None = None) -> ImportResult:
        if not content.startswith(b"MThd"):
            raise ScoreImportError("文件签名不是标准 MIDI")
        try:
            validate_midi_bytes(content)
            midi = mido.MidiFile(file=BytesIO(content))
        except MidiFileValidationError as exc:
            raise ScoreImportError(str(exc)) from exc
        notes, pitches_by_track = _read_notes(midi)
        if len(notes) > config.MAX_SCORE_NOTES:
            raise ScoreLimitError("MIDI 音符数量超过上限")

        tempos: list[int] = []
        signatures: list[tuple[int, int]] = []
        tempo_map: list[dict[str, float]] = []
        meter_map: list[dict[str, float | str]] = []
        absolute_tick = 0
        for message in mido.merge_tracks(midi.tracks):
            absolute_tick += message.time
            beat = absolute_tick / midi.ticks_per_beat
            if message.type == "set_tempo":
                tempos.append(message.tempo)
                tempo_map.append({"absoluteBeat": beat,
                                  "bpm": round(mido.tempo2bpm(message.tempo), 3)})
            elif message.type == "time_signature":
                signatures.append((message.numerator, message.denominator))
                meter_map.append({"absoluteBeat": beat,
                                  "timeSignature": f"{message.numerator}/{message.denominator}"})
        default_tempo = round(mido.tempo2bpm(tempos[0]), 3) if tempos else 120.0
        default_signature = f"{signatures[0][0]}/{signatures[0][1]}" if signatures else "4/4"
        default_mapping, warnings, confidence = _default_track_mapping(pitches_by_track)
        if not tempos:
            warnings.append("MIDI 未包含速度标记；已按标准 MIDI 默认值 120 BPM")
            confidence -= 0.05
        elif len(set(tempos)) > 1:
            warnings.append("原始 MIDI 含速度变化；播放保留原时间线，简化谱使用起始速度")
        if not signatures:
            warnings.append("MIDI 未包含拍号；已默认使用 4/4")
            confidence -= 0.05
        if len(set(signatures)) > 1:
            warnings.append("原始 MIDI 含拍号变化；简化谱使用起始拍号")

        resolved = normalization or ScoreNormalization(
            tempo=default_tempo, timeSignature=default_signature,
            quantization="1/16", trackMapping=default_mapping, confirmed=False,
        )
        _num, _den, measure_beats = _parse_time_signature(resolved.timeSignature)
        quantum = QUANTIZATION_BEATS[resolved.quantization]
        mapping: dict[str, str] = dict(default_mapping)
        mapping.update(resolved.trackMapping)

        grouped: dict[tuple[str, int, float], dict[str, object]] = {}
        quantization_error = 0.0
        last_beat = 0.0
        for note in notes:
            raw_onset = note.start_tick / midi.ticks_per_beat
            raw_duration = max(1 / midi.ticks_per_beat,
                               (note.end_tick - note.start_tick) / midi.ticks_per_beat)
            onset = round(raw_onset / quantum) * quantum
            duration = max(quantum, round(raw_duration / quantum) * quantum)
            quantization_error = max(quantization_error, abs(raw_onset - onset))
            mapped = mapping.get(str(note.track), "split")
            if mapped == "ignore":
                continue
            part = mapped if mapped in {"RH", "LH"} else ("RH" if note.pitch >= 60 else "LH")
            measure = int(onset // measure_beats) + 1
            in_measure = round(onset - (measure - 1) * measure_beats, 6)
            if in_measure >= measure_beats:
                measure += 1
                in_measure = 0.0
            key = (part, measure, in_measure)
            item = grouped.setdefault(
                key, {"pitches": [], "velocities": [], "duration": 0.0})
            item["pitches"].append(note.pitch)  # type: ignore[union-attr]
            item["velocities"].append(note.velocity)  # type: ignore[union-attr]
            item["duration"] = max(float(item["duration"]), duration)
            last_beat = max(last_beat, onset + duration)
        if not grouped:
            raise ScoreImportError("轨道映射忽略了全部音符")
        try:
            duration_seconds = float(midi.length)
        except (ValueError, TypeError):
            duration_seconds = last_beat * 60 / resolved.tempo
        if duration_seconds > config.MAX_SCORE_DURATION_SECONDS:
            raise ScoreLimitError("MIDI 时长超过上限")
        measure_count = max(key[1] for key in grouped)
        if measure_count > config.MAX_MEASURES:
            raise ScoreLimitError(f"小节数 {measure_count} 超过上限 {config.MAX_MEASURES}")
        if quantization_error > quantum * 0.35:
            warnings.append("部分音符偏离量化网格较多；简化谱可能与表达性演奏不同")
            confidence -= 0.08

        events: list[ScoreEvent] = []
        counters: dict[tuple[str, int], int] = defaultdict(int)
        for (part, measure, onset), item in sorted(
                grouped.items(), key=lambda pair: (pair[0][1], pair[0][2], pair[0][0])):
            counters[(part, measure)] += 1
            events.append(ScoreEvent(
                eventId=f"{score_id}:{part}:m{measure}:b{str(onset).replace('.', '_')}:"
                        f"{counters[(part, measure)]}",
                measureNo=measure, onsetBeat=onset, absoluteBeat=onset,
                durationBeat=min(float(item["duration"]), measure_beats - onset),
                pitches=sorted(set(item["pitches"])),  # type: ignore[arg-type]
                part=part, voice=1,
                dynamicTarget=round(statistics.median(item["velocities"])),  # type: ignore[arg-type]
            ))
        bundle = ScoreBundle(meta=ScoreMeta(
            scoreId=score_id, title=Path(filename).stem or "MIDI 乐曲",
            tempo=resolved.tempo, timeSignature=resolved.timeSignature,
            beatsPerMeasure=measure_beats, measureCount=measure_count,
            parts=sorted({event.part for event in events}, reverse=True),
            tempoMap=tempo_map, meterMap=meter_map,
            scoreHash=hashlib.sha256(content).hexdigest()[:16],
        ), events=events)
        with tempfile.TemporaryDirectory(prefix="music-mentor-midi-") as temp_dir:
            xml_path = Path(temp_dir) / "render.musicxml"
            events_to_musicxml(events, bundle.meta, resolved.tempo,
                               f"{bundle.meta.title}（量化简化谱）", xml_path)
            render = xml_path.read_bytes()
        normalized = NormalizedScore(
            scoreId=score_id, sourceType=ScoreSourceType.midi,
            displayMode=ScoreDisplayMode.simplified_quantized_staff,
            bundle=bundle, warnings=warnings, confidence=max(0.2, min(1.0, confidence)),
            normalization=resolved,
        )
        return ImportResult(
            normalized=normalized, source_bytes=content,
            source_suffix=Path(filename).suffix.lower() or ".mid",
            source_media_type="audio/midi", render_bytes=render,
            timeline_bytes=content,
        )
