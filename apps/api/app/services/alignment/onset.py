"""乐谱 Onset 聚类：对齐的最小单元。

同一 (measure, onsetBeat) 上可能有多个声部事件（如右手和弦 + 左手低音），
而演奏侧经和弦窗口聚合后是一个包含全部音高的 PerformanceGroup。
因此对齐在 onset 层进行（音高取并集），分类阶段再分配到各声部事件。
"""
from __future__ import annotations

from pydantic import BaseModel

from app.schemas.models import ScoreEvent


class ScoreOnset(BaseModel):
    onsetId: str                    # scoreId:m{measure}:b{onset}
    measureNo: int
    onsetBeat: float
    durationBeat: float
    pitches: list[int]              # 各声部音高并集
    members: list[ScoreEvent]       # 该 onset 上的声部事件
    optional: bool = False


def build_onsets(events: list[ScoreEvent]) -> list[ScoreOnset]:
    clusters: dict[tuple[int, float], list[ScoreEvent]] = {}
    for e in events:
        clusters.setdefault((e.measureNo, e.onsetBeat), []).append(e)
    out: list[ScoreOnset] = []
    for (m, onset), members in sorted(clusters.items()):
        pitches = sorted({p for e in members for p in e.pitches})
        token = f"{onset:g}".replace(".", "_")
        out.append(ScoreOnset(
            onsetId=f"{members[0].eventId.split(':')[0]}:m{m}:b{token}",
            measureNo=m,
            onsetBeat=onset,
            durationBeat=max(e.durationBeat for e in members),
            pitches=pitches,
            members=sorted(members, key=lambda e: e.part),
            optional=all(e.optional for e in members)))
    out.sort(key=lambda o: (o.measureNo, o.onsetBeat))
    return out
