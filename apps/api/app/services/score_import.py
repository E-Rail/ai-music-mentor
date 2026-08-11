"""乐谱导入与标准化（方案 5.1）。

MusicXML → ScoreEvent 序列：
- music21 解析，反复记号统一展开（复杂跳转 D.C./D.S. 返回 SCORE_UNSUPPORTED）
- 和弦音共享 onsetBeat，合并为一个 ScoreEvent
- 装饰音（grace note）设为 optional，不参与主评分
- eventId 规则：scoreId:part:measure:onset:index
"""
from __future__ import annotations

import hashlib
import re

import music21
from defusedxml import ElementTree as SafeET

from app import config
from app.schemas.models import ScoreBundle, ScoreEvent, ScoreMeta


class ScoreUnsupportedError(Exception):
    pass


_DYNAMIC_VELOCITY = {
    "pppp": 20, "ppp": 28, "pp": 36, "p": 46,
    "mp": 58, "mf": 72, "f": 86, "ff": 100,
    "fff": 112, "ffff": 120,
}


def _dynamic_target(element) -> int | None:
    """Return an explicit notation dynamic as a MIDI-velocity target."""
    dynamic = element.getContextByClass(music21.dynamics.Dynamic)
    value = str(getattr(dynamic, "value", "") or "").lower()
    return _DYNAMIC_VELOCITY.get(value)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _written_to_sounding_semitones(xml_bytes: bytes) -> int:
    """Read an explicit MusicXML transpose declaration without guessing."""
    try:
        root = SafeET.fromstring(xml_bytes)
    except Exception:
        return 0
    offsets: set[int] = set()
    for transpose in root.iter():
        if _local_name(transpose.tag) != "transpose":
            continue
        chromatic = 0
        octave_change = 0
        for child in transpose:
            name = _local_name(child.tag)
            try:
                if name == "chromatic":
                    chromatic = int(child.text or "0")
                elif name == "octave-change":
                    octave_change = int(child.text or "0")
            except ValueError:
                return 0
        offsets.add(chromatic + 12 * octave_change)
    # A single global offset is safe for the one-instrument microphone scope.
    # Mixed transpositions are left unchanged rather than guessed.
    return offsets.pop() if len(offsets) == 1 else 0


def _detect_part_name(part: music21.stream.Part, index: int) -> str:
    """根据五线谱行/名称粗分 RH/LH（钢琴惯例：P1=RH，P2=LH）。"""
    name = (part.partName or "").lower()
    if any(k in name for k in ("left", "lh", "bass", "左")):
        return "LH"
    if any(k in name for k in ("right", "rh", "treble", "右")):
        return "RH"
    # 钢琴 Grand Staff：第一个 part 右手，第二个左手
    return "RH" if index == 0 else "LH"


def _has_complex_repeats(score: music21.stream.Score) -> bool:
    """MVP 不支持复杂跳转（D.C./D.S./Coda），反复记号可展开。"""
    for el in score.recurse():
        if isinstance(el, music21.repeat.RepeatMark):
            if not isinstance(el, music21.bar.Repeat):
                return True
    return False


def parse_musicxml(xml_bytes: bytes, score_id: str) -> ScoreBundle:
    """解析 MusicXML 为标准化 ScoreBundle。反复记号展开为线性事件流。"""
    try:
        score = music21.converter.parse(xml_bytes, format="musicxml")
    except Exception as e:  # noqa: BLE001
        raise ScoreUnsupportedError(f"MusicXML 解析失败: {e}") from e

    if _has_complex_repeats(score):
        raise ScoreUnsupportedError("含 D.C./D.S./Coda 等复杂跳转，MVP 不支持，请导出简化 MusicXML")

    # 展开反复记号，得到线性演奏顺序
    try:
        expanded = score.expandRepeats()
    except Exception:  # noqa: BLE001
        expanded = score

    meta = _extract_meta(expanded, xml_bytes, score_id)
    if meta.measureCount > config.MAX_MEASURES:
        raise ScoreUnsupportedError(
            f"小节数 {meta.measureCount} 超过上限 {config.MAX_MEASURES}")

    events = _extract_events(expanded, score_id)
    if not events:
        raise ScoreUnsupportedError("乐谱中没有可练习的音符")
    note_count = sum(len(event.pitches) for event in events)
    if note_count > config.MAX_SCORE_NOTES:
        raise ScoreUnsupportedError(f"音符数量 {note_count} 超过上限 {config.MAX_SCORE_NOTES}")
    max_beat = max(
        (event.absoluteBeat if event.absoluteBeat is not None else
         (event.measureNo - 1) * meta.beatsPerMeasure + event.onsetBeat)
        + event.durationBeat for event in events
    )
    if max_beat * 60 / max(meta.tempo, 1) > config.MAX_SCORE_DURATION_SECONDS:
        raise ScoreUnsupportedError("乐谱演奏时长超过上限")
    # Only a written p/mf/f licenses grading a performance against a dynamic.
    meta.hasNotatedDynamics = any(
        event.dynamicTarget is not None for event in events)
    return ScoreBundle(meta=meta, events=events)


def _extract_meta(score: music21.stream.Score, xml_bytes: bytes, score_id: str) -> ScoreMeta:
    md = score.metadata
    title = (md.title if md and md.title else score_id) or score_id
    composer = (md.composer if md and md.composer else "") or ""

    tempos = score.recurse().getElementsByClass(music21.tempo.MetronomeMark)
    bpm = float(tempos[0].number) if len(tempos) and tempos[0].number else 96.0

    ts_list = score.recurse().getElementsByClass(music21.meter.TimeSignature)
    ts_str = ts_list[0].ratioString if len(ts_list) else "4/4"
    # ScoreEvent offsets and durations use quarterLength units. Keep the
    # measure span in that same unit for every denominator (2/2 = 4, 3/8 = 1.5).
    beats_per_measure = (
        float(ts_list[0].numerator) * 4.0 / float(ts_list[0].denominator)
        if len(ts_list) else 4.0
    )

    parts = [p.partName or f"P{i+1}" for i, p in enumerate(score.parts)]
    measure_count = 0
    for p in score.parts:
        measure_count = max(measure_count, len(p.getElementsByClass(music21.stream.Measure)))

    score_hash = hashlib.sha256(xml_bytes).hexdigest()[:16]
    tempo_map = []
    for mark in tempos:
        if not mark.number:
            continue
        measure = mark.getContextByClass(music21.stream.Measure)
        tempo_map.append({"measureNo": _linear_measure_number(measure),
                          "onsetBeat": float(mark.offset), "bpm": float(mark.number)})
    meter_map = []
    for signature in ts_list:
        measure = signature.getContextByClass(music21.stream.Measure)
        meter_map.append({"measureNo": _linear_measure_number(measure),
                          "onsetBeat": float(signature.offset),
                          "timeSignature": signature.ratioString})
    return ScoreMeta(
        scoreId=score_id, title=title, composer=composer, tempo=bpm,
        timeSignature=ts_str, beatsPerMeasure=beats_per_measure,
        measureCount=measure_count, parts=parts,
        tempoMap=tempo_map, meterMap=meter_map, scoreHash=score_hash,
        writtenToSoundingSemitones=_written_to_sounding_semitones(xml_bytes),
    )


def _linear_measure_number(measure: music21.stream.Measure | None) -> int:
    """Return a sequential timeline position after repeat expansion.

    music21 preserves the printed number on repeated copies and adds suffixes
    such as ``1a``. A normalized performance timeline must instead give every
    pass a unique measure number and stable event ID.
    """
    if measure is None:
        return 1
    part = measure.getContextByClass(music21.stream.Part)
    if part is not None:
        for index, candidate in enumerate(
                part.getElementsByClass(music21.stream.Measure), start=1):
            if candidate is measure:
                return index
    return max(1, int(measure.measureNumber or 1))


def _extract_events(score: music21.stream.Score, score_id: str) -> list[ScoreEvent]:
    """按声部提取 ScoreEvent；和弦合并；装饰音标记 optional。"""
    events: list[ScoreEvent] = []
    for p_idx, part in enumerate(score.parts):
        part_name = _detect_part_name(part, p_idx)
        # 展平到 measure 层级，按 (measure, onset) 聚合和弦
        measures = part.getElementsByClass(music21.stream.Measure)
        for m_no, meas in enumerate(measures, start=1):
            # measure 内 offset（quarterLength），转为拍
            groups: dict[tuple[float, int], dict] = {}
            for el in meas.recurse().notesAndRests:
                if el.isRest:
                    continue
                onset_q = float(el.offset)
                voice_context = el.getContextByClass(music21.stream.Voice)
                try:
                    voice = int(voice_context.id) if voice_context is not None else 1
                except (TypeError, ValueError):
                    voice = 1
                key = (onset_q, voice)
                if key not in groups:
                    groups[key] = {"pitches": [], "dur": 0.0,
                                   "optional": False, "voice": voice,
                                   "dynamicTargets": []}
                g = groups[key]
                if el.isChord:
                    g["pitches"].extend(n.pitch.midi for n in el.notes)
                else:
                    g["pitches"].append(el.pitch.midi)
                g["dur"] = max(g["dur"], float(el.duration.quarterLength))
                if el.duration.isGrace:
                    g["optional"] = True
                dynamic_target = _dynamic_target(el)
                if dynamic_target is not None:
                    g["dynamicTargets"].append(dynamic_target)
            for idx, (onset_q, voice) in enumerate(sorted(groups)):
                g = groups[(onset_q, voice)]
                if not g["pitches"]:
                    continue
                onset_token = re.sub(r"\.", "_", f"{onset_q:g}")
                events.append(ScoreEvent(
                    eventId=f"{score_id}:{part_name}:m{m_no}:b{onset_token}:{idx}",
                    measureNo=m_no,
                    onsetBeat=onset_q,
                    absoluteBeat=float(meas.offset) + onset_q,
                    durationBeat=g["dur"],
                    pitches=sorted(set(g["pitches"])),
                    part=part_name,
                    voice=g["voice"],
                    dynamicTarget=(round(sum(g["dynamicTargets"]) /
                                         len(g["dynamicTargets"]))
                                   if g["dynamicTargets"] else None),
                    optional=g["optional"],
                ))
    # 全局按 (measure, onset, part) 排序
    events.sort(key=lambda e: (e.measureNo, e.onsetBeat, 0 if e.part == "RH" else 1))
    return events


def export_reference_midi(bundle: ScoreBundle, out_path) -> None:
    """从 ScoreEvent 生成参考 MIDI（reference.mid），供播放/伴奏基线。"""
    import mido

    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    sec_per_beat = 60.0 / bundle.meta.tempo
    track.append(mido.MetaMessage("set_tempo", tempo=int(sec_per_beat * 1_000_000), time=0))

    # 全局拍点 = measureNo-1 小节偏移 + onsetBeat
    bpm_ = bundle.meta.beatsPerMeasure
    msgs = []
    for e in bundle.events:
        if e.optional:
            continue
        abs_beat = (e.absoluteBeat if e.absoluteBeat is not None else
                    (e.measureNo - 1) * bpm_ + e.onsetBeat)
        for p in e.pitches:
            msgs.append((abs_beat, 1, p, 72))                      # note_on
            msgs.append((abs_beat + e.durationBeat, 0, p, 0))      # note_off
    msgs.sort(key=lambda m: (m[0], m[1]))
    last = 0.0
    for beat, on, pitch, vel in msgs:
        delta = int(round((beat - last) * 480))
        last = beat
        track.append(mido.Message("note_on" if on else "note_off",
                                  note=pitch, velocity=vel, time=max(0, delta)))
    track.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(out_path)
