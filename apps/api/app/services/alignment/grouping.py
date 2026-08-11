"""音符分组（方案 5.3）：和弦窗口聚合。

钢琴和弦各音不会在完全相同的毫秒到达。相邻 Note On 按窗口聚合；
默认 70ms，BPM 很慢（<60）时上调到 100ms。分组后再与 ScoreEvent
音高集合比较，避免把和弦误判成多音。
"""
from __future__ import annotations

from app.schemas.models import PerformanceEvent, PerformanceGroup


def group_chord_onsets(events: list[PerformanceEvent],
                       window_ms: float = 70.0,
                       bpm: float | None = None) -> list[PerformanceGroup]:
    if bpm is not None and bpm < 60:
        window_ms = 100.0
    onsets = sorted(events, key=lambda e: (e.tOnMs, e.pitch))
    groups: list[list[PerformanceEvent]] = []
    for ev in onsets:
        # The chord window is anchored to the first onset. Comparing against the
        # previous note creates a chain where 0/60/120 ms incorrectly becomes
        # one chord even though the final note is outside a 70 ms window.
        if groups and ev.tOnMs - groups[-1][0].tOnMs <= window_ms:
            groups[-1].append(ev)
        else:
            groups.append([ev])

    out: list[PerformanceGroup] = []
    for i, g in enumerate(groups):
        out.append(PerformanceGroup(
            id=f"g_{i:04d}",
            tOnMs=min(e.tOnMs for e in g),
            tOffMs=max(e.tOffMs for e in g),
            pitches=sorted({e.pitch for e in g}),
            velocities=[e.velocity for e in g],
            eventIds=[e.id for e in g],
        ))
    return out
