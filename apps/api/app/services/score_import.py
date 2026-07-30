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

from app.schemas.models import ScoreBundle, ScoreEvent, ScoreMeta


class ScoreUnsupportedError(Exception):
    pass


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
    if meta.measureCount > 200:
        raise ScoreUnsupportedError(f"小节数 {meta.measureCount} 超过上限 200")

    events = _extract_events(expanded, score_id)
    return ScoreBundle(meta=meta, events=events)


def _extract_meta(score: music21.stream.Score, xml_bytes: bytes, score_id: str) -> ScoreMeta:
    md = score.metadata
    title = (md.title if md and md.title else score_id) or score_id
    composer = (md.composer if md and md.composer else "") or ""

    tempos = score.recurse().getElementsByClass(music21.tempo.MetronomeMark)
    bpm = float(tempos[0].number) if len(tempos) and tempos[0].number else 96.0

    ts_list = score.recurse().getElementsByClass(music21.meter.TimeSignature)
    ts_str = ts_list[0].ratioString if len(ts_list) else "4/4"
    beats_per_measure = float(ts_list[0].numerator) if len(ts_list) else 4.0
    if ts_list and ts_list[0].denominator == 8:
        beats_per_measure = float(ts_list[0].numerator) / 2.0  # 6/8 → 3 拍

    parts = [p.partName or f"P{i+1}" for i, p in enumerate(score.parts)]
    measure_count = 0
    for p in score.parts:
        measure_count = max(measure_count, len(p.getElementsByClass(music21.stream.Measure)))

    score_hash = hashlib.sha256(xml_bytes).hexdigest()[:16]
    return ScoreMeta(
        scoreId=score_id, title=title, composer=composer, tempo=bpm,
        timeSignature=ts_str, beatsPerMeasure=beats_per_measure,
        measureCount=measure_count, parts=parts, scoreHash=score_hash,
    )


def _extract_events(score: music21.stream.Score, score_id: str) -> list[ScoreEvent]:
    """按声部提取 ScoreEvent；和弦合并；装饰音标记 optional。"""
    events: list[ScoreEvent] = []
    for p_idx, part in enumerate(score.parts):
        part_name = _detect_part_name(part, p_idx)
        # 展平到 measure 层级，按 (measure, onset) 聚合和弦
        measures = part.getElementsByClass(music21.stream.Measure)
        for meas in measures:
            m_no = int(meas.measureNumber or 0)
            # measure 内 offset（quarterLength），转为拍
            groups: dict[float, dict] = {}
            for el in meas.recurse().notesAndRests:
                if el.isRest:
                    continue
                onset_q = float(el.offset)
                if onset_q not in groups:
                    groups[onset_q] = {"pitches": [], "dur": 0.0, "optional": False, "voice": 1}
                g = groups[onset_q]
                if el.isChord:
                    g["pitches"].extend(n.pitch.midi for n in el.notes)
                else:
                    g["pitches"].append(el.pitch.midi)
                g["dur"] = max(g["dur"], float(el.duration.quarterLength))
                if el.duration.isGrace:
                    g["optional"] = True
            for idx, onset_q in enumerate(sorted(groups)):
                g = groups[onset_q]
                if not g["pitches"]:
                    continue
                onset_token = re.sub(r"\.", "_", f"{onset_q:g}")
                events.append(ScoreEvent(
                    eventId=f"{score_id}:{part_name}:m{m_no}:b{onset_token}:{idx}",
                    measureNo=m_no,
                    onsetBeat=onset_q,
                    durationBeat=g["dur"],
                    pitches=sorted(set(g["pitches"])),
                    part=part_name,
                    voice=g["voice"],
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
        abs_beat = (e.measureNo - 1) * bpm_ + e.onsetBeat
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
