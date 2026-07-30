"""能力指标（方案 5.6）。

overallScore = 0.45×pitch + 0.35×rhythm + 0.15×fluency + 0.05×dynamics
乐谱无力度标记时，dynamics 权重按比例分配给 pitch 与 rhythm。
综合分数只用于趋势展示，不掩盖细节。

pitch 按声部事件计：matched onset 中某声部音高全部弹出记为正确；
漏音/错音计入分母。
"""
from __future__ import annotations

import statistics

from app.schemas.models import (AlignmentPair, AlignOp, Metrics,
                                PerformanceGroup)
from app.services.alignment.onset import ScoreOnset


def calculate_metrics(pairs: list[AlignmentPair],
                      onset_index: dict[str, ScoreOnset],
                      group_index: dict[str, PerformanceGroup],
                      beats_per_measure: float,
                      bpm: float,
                      has_dynamics: bool = False) -> Metrics:
    # 期望声部事件总数（range 内非 optional）
    member_total = sum(1 for o in onset_index.values()
                       for m in o.members if not m.optional)

    n_correct = 0
    n_missed = 0
    n_wrong = 0
    matched: list[AlignmentPair] = []
    for p in pairs:
        o = onset_index.get(p.scoreEventId or "")
        g = group_index.get(p.performanceId or "")
        if p.operation in (AlignOp.match, AlignOp.substitute):
            matched.append(p)
            if o and g:
                for m in o.members:
                    if m.optional:
                        continue
                    if set(m.pitches) <= set(g.pitches):
                        n_correct += 1
                    elif not (set(m.pitches) & set(g.pitches)):
                        n_missed += 1
                    else:
                        n_wrong += 1
        elif p.operation == AlignOp.delete and o:
            n_missed += sum(1 for m in o.members if not m.optional)
    n_extra = sum(1 for p in pairs if p.operation == AlignOp.insert)

    residuals = [abs(p.onsetResidualMs) for p in matched]
    timing_mae = statistics.mean(residuals) if residuals else 0.0
    timing_threshold = max(80.0, 0.12 * 60000.0 / bpm)
    on_time = sum(1 for r in residuals if r <= timing_threshold)
    on_time_ratio = on_time / len(residuals) if residuals else 0.0

    pitch_score = 100.0 * n_correct / member_total if member_total else 100.0
    rhythm_score = (0.6 * on_time_ratio * 100.0
                    + 0.4 * 100.0 * max(0.0, 1.0 - timing_mae / 300.0))
    avg_bpm, cv = _tempo_stats(matched, onset_index, group_index, beats_per_measure)
    fluency_score = 100.0 * max(0.0, 1.0 - cv / 0.15)
    fluency_score = max(0.0, fluency_score - 4.0 * (n_extra + n_missed) - 2.0 * n_wrong)
    dynamics_score = 100.0

    pitch_score = round(min(100.0, max(0.0, pitch_score)), 1)
    rhythm_score = round(min(100.0, max(0.0, rhythm_score)), 1)
    fluency_score = round(min(100.0, max(0.0, fluency_score)), 1)

    if has_dynamics:
        overall = (0.45 * pitch_score + 0.35 * rhythm_score
                   + 0.15 * fluency_score + 0.05 * dynamics_score)
    else:
        overall = ((0.45 * pitch_score + 0.35 * rhythm_score
                    + 0.15 * fluency_score) / 0.95)

    return Metrics(
        pitchScore=pitch_score, rhythmScore=rhythm_score,
        fluencyScore=fluency_score, dynamicsScore=dynamics_score,
        overallScore=round(min(100.0, max(0.0, overall)), 1),
        timingMaeMs=round(timing_mae, 1),
        avgBpm=round(avg_bpm, 1),
        matchedCount=len(matched), expectedCount=member_total)


def _tempo_stats(matched: list[AlignmentPair],
                 onset_index: dict[str, ScoreOnset],
                 group_index: dict[str, PerformanceGroup],
                 beats_per_measure: float) -> tuple[float, float]:
    pts = []
    for p in matched:
        o = onset_index.get(p.scoreEventId or "")
        g = group_index.get(p.performanceId or "")
        if o and g:
            beat = (o.measureNo - 1) * beats_per_measure + o.onsetBeat
            pts.append((beat, g.tOnMs))
    pts.sort()
    bpms = []
    for (b0, m0), (b1, m1) in zip(pts, pts[1:]):
        if b1 > b0 and m1 > m0:
            bpms.append(60.0 / ((m1 - m0) / (b1 - b0) / 1000.0))
    if not bpms:
        return 0.0, 0.0
    mean = statistics.mean(bpms)
    cv = statistics.pstdev(bpms) / mean if mean else 0.0
    return mean, cv
