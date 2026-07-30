"""MIDI 文件 ↔ PerformanceEvent（上传 MIDI 降级路径 & 测试加载）。"""
from __future__ import annotations

import mido

from app.schemas.models import PerformanceEvent


def load_midi_events(path: str) -> list[PerformanceEvent]:
    mid = mido.MidiFile(path)
    ticks_per_beat = mid.ticks_per_beat
    events: list[PerformanceEvent] = []
    for track in mid.tracks:
        tempo = 500000  # 默认 120BPM
        abs_ms = 0.0
        # 同音高可能重叠（重复触发/注入偏移），用 FIFO 队列配对 note_on/off
        active: dict[int, list[tuple[float, int]]] = {}
        n = 0
        for msg in track:
            abs_ms += mido.tick2second(msg.time, ticks_per_beat, tempo) * 1000.0
            if msg.type == "set_tempo":
                tempo = msg.tempo
            elif msg.type == "note_on" and msg.velocity > 0:
                active.setdefault(msg.note, []).append((abs_ms, msg.velocity))
            elif msg.type in ("note_off",) or (msg.type == "note_on" and msg.velocity == 0):
                if active.get(msg.note):
                    t_on, vel = active[msg.note].pop(0)
                    n += 1
                    events.append(PerformanceEvent(
                        id=f"pe_{n:05d}", tOnMs=t_on, tOffMs=abs_ms,
                        pitch=msg.note, velocity=vel, source="midi-file"))
        # 补未闭合音符
        for note, ons in active.items():
            for t_on, vel in ons:
                n += 1
                events.append(PerformanceEvent(
                    id=f"pe_{n:05d}", tOnMs=t_on, tOffMs=t_on + 200.0,
                    pitch=note, velocity=vel, source="midi-file"))
    events.sort(key=lambda e: (e.tOnMs, e.pitch))
    for i, e in enumerate(events, 1):
        e.id = f"pe_{i:05d}"
    return events


def events_to_midi(events: list[PerformanceEvent], path: str, bpm: float = 96.0) -> None:
    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=int(60 / bpm * 1_000_000), time=0))
    beat_ms = 60000.0 / bpm
    msgs = []
    for e in events:
        msgs.append((e.tOnMs, 1, e.pitch, e.velocity))
        msgs.append((max(e.tOffMs, e.tOnMs + 30), 0, e.pitch, 0))
    msgs.sort(key=lambda m: (m[0], m[1]))
    last = 0.0
    for t, on, pitch, vel in msgs:
        delta = int(round((t - last) / beat_ms * 480))
        last = t
        track.append(mido.Message("note_on" if on else "note_off",
                                  note=pitch, velocity=vel, time=max(0, delta)))
    track.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(path)
