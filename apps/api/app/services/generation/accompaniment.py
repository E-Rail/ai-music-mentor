"""自适应伴奏生成（方案 5.9）：简化和弦/低音 MIDI，按小节调速由前端执行。

伴奏来源优先内置和弦/低音：每小节 低音(根音, 1/3拍) + 和弦(2/4拍)。
复杂原曲伴奏不作为首版要求。
"""
from __future__ import annotations

import uuid
from pathlib import Path

import mido

from app.schemas.models import ScoreBundle


def generate_accompaniment(bundle: ScoreBundle,
                           range_start: int, range_end: int,
                           out_dir: Path) -> dict:
    meta = bundle.meta
    end = range_end if range_end > 0 else meta.measureCount
    events = [e for e in bundle.events
              if range_start <= e.measureNo <= end and not e.optional]

    acc_id = f"acc_{uuid.uuid4().hex[:10]}"
    midi_path = out_dir / f"{acc_id}.mid"

    ticks = 480
    mid = mido.MidiFile(ticks_per_beat=ticks)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo",
                               tempo=int(60 / meta.tempo * 1_000_000), time=0))

    # 每小节首 onset 的和声 → 低音 + 和弦垫
    by_measure: dict[int, list] = {}
    for e in events:
        by_measure.setdefault(e.measureNo, []).append(e)

    msgs = []
    bpm_ = meta.beatsPerMeasure
    for m_no in range(range_start, end + 1):
        m_events = sorted(by_measure.get(m_no, []), key=lambda e: e.onsetBeat)
        base = (m_no - range_start) * bpm_
        if not m_events:
            continue
        harmony = m_events[0].pitches
        bass = max(24, min(harmony) - 12)
        # 低音：第 1、3 拍
        for beat in (0.0, 2.0):
            if beat >= bpm_:
                continue
            msgs.append((base + beat, 1, bass, 56))
            msgs.append((base + beat + 0.9, 0, bass, 0))
        # 和弦垫：第 2、4 拍
        for beat in (1.0, 3.0):
            if beat >= bpm_:
                continue
            for p in harmony:
                msgs.append((base + beat, 1, p, 40))
                msgs.append((base + beat + 0.9, 0, p, 0))
    msgs.sort(key=lambda m: (m[0], m[1], m[2]))
    last = 0.0
    for beat, on, p, vel in msgs:
        delta = int(round((beat - last) * ticks))
        last = beat
        tr.append(mido.Message("note_on" if on else "note_off",
                               note=int(p), velocity=int(vel),
                               time=max(0, delta)))
    tr.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(midi_path)

    # 每小节的和声事件（前端按小节重排程用）
    harmony_events = [
        {"measure": m, "pitches": sorted(by_measure.get(m, [None])[0].pitches)
         if by_measure.get(m) else []}
        for m in range(range_start, end + 1)
    ]
    return {
        "accompanimentId": acc_id,
        "midiPath": str(midi_path),
        "baseTempo": meta.tempo,
        "harmonyEvents": harmony_events,
        "beatsPerMeasure": bpm_,
    }
