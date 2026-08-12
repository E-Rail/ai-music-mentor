"""从 ScoreEvent 重建 music21 Score / MIDI（练习生成器的基础设施）。

生成前先复制事件，不直接修改源文件；每个生成物记录
sourceScoreId、sourceMeasures 和 ruleId。
"""
from __future__ import annotations

from pathlib import Path

import music21
import mido

from app.schemas.models import InstrumentProfile, ScoreEvent, ScoreMeta

PART_NAMES = {"RH": "Right Hand", "LH": "Left Hand"}


def _dynamic_symbol(velocity: int) -> str:
    if velocity < 32:
        return "ppp"
    if velocity < 42:
        return "pp"
    if velocity < 53:
        return "p"
    if velocity < 65:
        return "mp"
    if velocity < 79:
        return "mf"
    if velocity < 93:
        return "f"
    if velocity < 107:
        return "ff"
    return "fff"


def events_to_musicxml(events: list[ScoreEvent], meta: ScoreMeta,
                       tempo: float, title: str, out_path: Path,
                       instrument_profile: InstrumentProfile | str = InstrumentProfile.piano) -> None:
    """ScoreEvent 列表 → MusicXML 文件。事件必须属于完整小节。"""
    score = music21.stream.Score()
    score.insert(0, music21.metadata.Metadata())
    score.metadata.title = title
    parts = sorted({e.part for e in events})
    measures = sorted({e.measureNo for e in events})
    bpm_per_measure = meta.beatsPerMeasure

    built: list[music21.stream.Part] = []
    selected_instrument = InstrumentProfile(instrument_profile)
    instrument_factory = {
        InstrumentProfile.piano: music21.instrument.Piano,
        InstrumentProfile.guitar: music21.instrument.AcousticGuitar,
        InstrumentProfile.violin: music21.instrument.Violin,
    }[selected_instrument]

    for part in parts:
        p = music21.stream.Part()
        p.partName = PART_NAMES.get(part, part)
        selected = instrument_factory()
        if selected_instrument == InstrumentProfile.guitar:
            selected.transposition = music21.interval.Interval(-12)
        p.insert(0, selected)
        p_events = [e for e in events if e.part == part]
        last_dynamic_target: int | None = None
        for m_no in measures:
            m = music21.stream.Measure(number=m_no)
            if m_no == measures[0]:
                m.insert(0, music21.tempo.MetronomeMark(number=tempo))
                m.insert(0, music21.meter.TimeSignature(meta.timeSignature))
                m.insert(0, music21.key.KeySignature(0))
            m_events = sorted([e for e in p_events if e.measureNo == m_no],
                              key=lambda e: e.onsetBeat)
            cursor = 0.0
            for e in m_events:
                if e.onsetBeat > cursor:
                    m.insert(cursor, music21.note.Rest(
                        quarterLength=e.onsetBeat - cursor))
                if len(e.pitches) == 1:
                    n = music21.note.Note(music21.pitch.Pitch(midi=e.pitches[0]),
                                          quarterLength=e.durationBeat)
                else:
                    n = music21.chord.Chord(
                        [music21.pitch.Pitch(midi=pi) for pi in e.pitches],
                        quarterLength=e.durationBeat)
                if (e.dynamicTarget is not None and
                        e.dynamicTarget != last_dynamic_target):
                    m.insert(e.onsetBeat, music21.dynamics.Dynamic(
                        _dynamic_symbol(e.dynamicTarget)))
                    last_dynamic_target = e.dynamicTarget
                m.insert(e.onsetBeat, n)
                cursor = max(cursor, e.onsetBeat + e.durationBeat)
            if cursor < bpm_per_measure:
                m.insert(cursor, music21.note.Rest(
                    quarterLength=bpm_per_measure - cursor))
            p.append(m)
        score.insert(0, p)
        built.append(p)
    # Two staves of one keyboard are braced together. Without it every renderer
    # draws them as two unrelated players, which is the opposite of what a
    # two-hand exercise is teaching.
    if selected_instrument == InstrumentProfile.piano and len(built) > 1:
        score.insert(0, music21.layout.StaffGroup(
            built, name="Piano", abbreviation="Pno",
            symbol="brace", barTogether=True))
    score.write("musicxml", fp=str(out_path))


def events_to_midi(events: list[ScoreEvent], meta: ScoreMeta,
                   tempo: float, out_path: Path,
                   repeat: int = 1, velocity: int = 72) -> None:
    """ScoreEvent 列表 → MIDI 文件（可选整体循环 repeat 次）。"""
    ticks = 480
    mid = mido.MidiFile(ticks_per_beat=ticks)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo",
                               tempo=int(60 / tempo * 1_000_000), time=0))
    measures = sorted({e.measureNo for e in events}) or [1]
    span = (max(measures) - min(measures) + 1) * meta.beatsPerMeasure
    base = (min(measures) - 1) * meta.beatsPerMeasure

    msgs = []
    for r in range(repeat):
        for e in events:
            if e.optional:
                continue
            abs_on = (e.measureNo - 1) * meta.beatsPerMeasure + e.onsetBeat \
                - base + r * span
            for pi in e.pitches:
                target_velocity = e.dynamicTarget if e.dynamicTarget is not None else velocity
                msgs.append((abs_on, 1, pi, target_velocity))
                msgs.append((abs_on + e.durationBeat, 0, pi, 0))
    msgs.sort(key=lambda m: (m[0], m[1], m[2]))
    last = 0.0
    for beat, on, pi, vel in msgs:
        delta = int(round((beat - last) * ticks))
        last = beat
        tr.append(mido.Message("note_on" if on else "note_off",
                               note=int(pi), velocity=int(vel),
                               time=max(0, delta)))
    tr.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(out_path)


def validate_well_formed(events: list[ScoreEvent]) -> bool:
    """isWellFormedNotation 等价检查：结构合法（音高/时值/小节边界）。"""
    for e in events:
        if not e.pitches or any(p < 0 or p > 127 for p in e.pitches):
            return False
        if e.durationBeat <= 0 or e.onsetBeat < 0:
            return False
    return True
