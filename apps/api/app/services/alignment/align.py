"""全局对齐（方案 5.5）：锚点 + 分段速度 + 动态规划最小代价路径。

不直接相信在线光标。两遍策略：
  1. 初始线性 tempoMap（标称 BPM）→ DP 粗对齐 → 收集 match 锚点
  2. 分段鲁棒速度拟合 → DP 精对齐 → 最终路径

短乐段通常几十到几百个事件，O(N×M) 1 秒内完成。

代价（方案 5.4/5.5 表）：
  pairCost = 0.9 × pitchSetDistance + 0.25 × normalizedOnsetResidual
  pitchSetDistance = 1 − |expected ∩ played| / |expected ∪ played|
  Delete = 1.0（optional 0.2）→ missed_note
  Insert = 0.8 → extra_note
  Substitute = pairCost（音高不同）→ wrong_pitch
"""
from __future__ import annotations

from app.schemas.models import (AlignmentPair, AlignOp, PerformanceGroup)
from app.services.alignment.onset import ScoreOnset
from app.services.alignment.tempo import TempoMap

DELETE_COST = 1.0
DELETE_COST_OPTIONAL = 0.2
INSERT_COST = 0.8
PITCH_W = 0.9
ONSET_W = 0.25


def pitch_set_distance(expected: list[int], played: list[int]) -> float:
    es, ps = set(expected), set(played)
    union = es | ps
    if not union:
        return 0.0
    return 1.0 - len(es & ps) / len(union)


def _norm_residual(residual_ms: float, beat_ms: float) -> float:
    scale = max(0.5 * beat_ms, 150.0)
    return min(1.0, abs(residual_ms) / scale)


def global_align(onsets: list[ScoreOnset],
                 groups: list[PerformanceGroup],
                 tempo_map: TempoMap,
                 beats_per_measure: float,
                 bpm: float) -> list[AlignmentPair]:
    """onset 层 DP 对齐（AlignmentPair.scoreEventId 存放 onsetId）。"""
    N, M = len(onsets), len(groups)
    if N == 0 or M == 0:
        pairs = [AlignmentPair(scoreEventId=o.onsetId, performanceId=None,
                               operation=AlignOp.delete,
                               cost=DELETE_COST_OPTIONAL if o.optional else DELETE_COST)
                 for o in onsets]
        pairs += [AlignmentPair(scoreEventId=None, performanceId=g.id,
                                operation=AlignOp.insert, cost=INSERT_COST)
                  for g in groups]
        return pairs

    beat_ms = 60000.0 / bpm
    abs_beats = [(o.measureNo - 1) * beats_per_measure + o.onsetBeat for o in onsets]
    expected_ms = [tempo_map.expected_ms(b) for b in abs_beats]
    gate_ms = 1.2 * beat_ms   # 超过 1.2 拍残差禁止匹配

    # pairCost 矩阵（inf = 禁止）
    INF = float("inf")
    pcost = [[INF] * M for _ in range(N)]
    presid = [[0.0] * M for _ in range(N)]
    pdist = [[1.0] * M for _ in range(N)]
    for i in range(N):
        for j in range(M):
            resid = groups[j].tOnMs - expected_ms[i]
            if abs(resid) > gate_ms:
                continue
            dist = pitch_set_distance(onsets[i].pitches, groups[j].pitches)
            pdist[i][j] = dist
            presid[i][j] = resid
            pcost[i][j] = PITCH_W * dist + ONSET_W * _norm_residual(resid, beat_ms)

    # DP
    D = [[0.0] * (M + 1) for _ in range(N + 1)]
    ptr = [[None] * (M + 1) for _ in range(N + 1)]
    for i in range(1, N + 1):
        D[i][0] = D[i - 1][0] + (DELETE_COST_OPTIONAL if onsets[i - 1].optional else DELETE_COST)
        ptr[i][0] = "D"
    for j in range(1, M + 1):
        D[0][j] = D[0][j - 1] + INSERT_COST
        ptr[0][j] = "I"
    for i in range(1, N + 1):
        so = onsets[i - 1]
        del_cost = DELETE_COST_OPTIONAL if so.optional else DELETE_COST
        for j in range(1, M + 1):
            c_pair = D[i - 1][j - 1] + pcost[i - 1][j - 1]
            c_del = D[i - 1][j] + del_cost
            c_ins = D[i][j - 1] + INSERT_COST
            best = min(c_pair, c_del, c_ins)
            D[i][j] = best
            ptr[i][j] = "P" if best == c_pair else ("D" if best == c_del else "I")

    # 回溯
    pairs: list[AlignmentPair] = []
    i, j = N, M
    while i > 0 or j > 0:
        p = ptr[i][j]
        if p == "P":
            so, g = onsets[i - 1], groups[j - 1]
            dist = pdist[i - 1][j - 1]
            resid = presid[i - 1][j - 1]
            exp_beat_dur_ms = max(1.0, so.durationBeat * beat_ms *
                                  (tempo_map.sec_per_beat_at(abs_beats[i - 1]) / (60.0 / bpm)))
            dur_ratio = g.durationMs / exp_beat_dur_ms
            op = AlignOp.match if dist == 0 else AlignOp.substitute
            cost = pcost[i - 1][j - 1]
            pairs.append(AlignmentPair(
                scoreEventId=so.onsetId, performanceId=g.id, operation=op,
                cost=cost, confidence=max(0.0, 1.0 - cost),
                onsetResidualMs=resid, durationRatio=dur_ratio))
            i -= 1
            j -= 1
        elif p == "D":
            so = onsets[i - 1]
            pairs.append(AlignmentPair(
                scoreEventId=so.onsetId, performanceId=None,
                operation=AlignOp.delete,
                cost=DELETE_COST_OPTIONAL if so.optional else DELETE_COST,
                confidence=0.9))
            i -= 1
        else:
            g = groups[j - 1]
            pairs.append(AlignmentPair(
                scoreEventId=None, performanceId=g.id,
                operation=AlignOp.insert, cost=INSERT_COST, confidence=0.85))
            j -= 1
    pairs.reverse()
    return pairs


def collect_matched_beats(pairs: list[AlignmentPair],
                          onset_index: dict[str, ScoreOnset],
                          group_index: dict[str, PerformanceGroup],
                          beats_per_measure: float) -> list[tuple[float, float]]:
    """从对齐路径收集 match 锚点 (scoreBeat, onsetMs)。

    高置信锚点：match 全部纳入；substitute 仅当音高距离很小（≤0.34，
    如和弦缺单音）时纳入，避免错音锚点带偏速度估计。
    """
    out = []
    for p in pairs:
        if p.scoreEventId and p.performanceId and p.operation in (
                AlignOp.match, AlignOp.substitute):
            so = onset_index[p.scoreEventId]
            g = group_index[p.performanceId]
            if p.operation == AlignOp.substitute and \
                    pitch_set_distance(so.pitches, g.pitches) > 0.34:
                continue
            beat = (so.measureNo - 1) * beats_per_measure + so.onsetBeat
            out.append((beat, g.tOnMs))
    return sorted(out)
