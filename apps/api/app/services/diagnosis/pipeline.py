"""诊断管线（方案 10.2 伪代码的工程实现）。

analyze(scoreEvents, performanceEvents):
  groups   = groupChordOnsets(performanceEvents, windowMs=70)
  anchors  = findHighConfidencePitchAnchors(scoreEvents, groups)   # 首遍 DP 的 match
  tempoMap = robustPiecewiseTempoFit(anchors)
  path     = globalDynamicAlignment(scoreEvents, groups, tempoMap)
  errors   = classifyErrors(path, tempoMap, thresholdProfile)
  patterns = aggregateRepeatedPatterns(errors, path)
  metrics  = calculateScores(path, errors)
"""
from __future__ import annotations

from app.schemas.models import (DiagnosisReport, Metrics, PerformanceEvent,
                                ScoreBundle, ScoreEvent)
from app.services.alignment.align import collect_matched_beats, global_align
from app.services.alignment.grouping import group_chord_onsets
from app.services.alignment.onset import build_onsets
from app.services.alignment.tempo import fit_piecewise_tempo, initial_tempo_map
from app.services.diagnosis.errors import classify_errors
from app.services.diagnosis.metrics import calculate_metrics
from app.services.diagnosis.patterns import aggregate_patterns, build_hypotheses


class LowConfidenceAlignmentError(Exception):
    """ALIGNMENT_LOW_CONFIDENCE：整体无法可靠对齐，不给确定性评分。"""


def filter_range(events: list[ScoreEvent], start: int, end: int) -> list[ScoreEvent]:
    end = end if end > 0 else 10 ** 9
    return [e for e in events if start <= e.measureNo <= end]


def run_analysis(bundle: ScoreBundle,
                 perf_events: list[PerformanceEvent],
                 report_id: str,
                 session_id: str,
                 range_start: int = 1,
                 range_end: int = 0,
                 created_at: str = "") -> DiagnosisReport:
    meta = bundle.meta
    score_events = filter_range(bundle.events, range_start, range_end)
    if not score_events:
        raise LowConfidenceAlignmentError("练习范围内没有乐谱事件")
    if not perf_events:
        raise LowConfidenceAlignmentError("没有演奏事件，请重录或缩短片段")

    bpm, bpm_per_measure = meta.tempo, meta.beatsPerMeasure

    # 1. 乐谱 onset 聚类 + 演奏和弦分组（慢速曲窗口上调）
    onsets = build_onsets(score_events)
    groups = group_chord_onsets(perf_events, window_ms=70.0, bpm=bpm)

    # 2. 两遍对齐：时长法初始速度 → 粗对齐 → 锚点分段速度 → 精对齐
    #    初始速度用"总时长/总拍数"估计，可容忍 ±30% 的整体快慢（global_slow 场景）
    first = onsets[0]
    last = onsets[-1]
    first_beat = (first.measureNo - 1) * bpm_per_measure + first.onsetBeat
    last_beat = (last.measureNo - 1) * bpm_per_measure + last.onsetBeat
    span_ms = groups[-1].tOnMs - groups[0].tOnMs
    span_beats = max(0.5, last_beat - first_beat)
    est_bpm = bpm
    if span_ms > 0:
        est_spb = span_ms / span_beats / 1000.0
        nominal_spb = 60.0 / bpm
        if 0.6 * nominal_spb <= est_spb <= 1.8 * nominal_spb:
            est_bpm = 60.0 / est_spb
    tmap0 = initial_tempo_map(first_beat, groups[0].tOnMs, est_bpm)
    pairs0 = global_align(onsets, groups, tmap0, bpm_per_measure, bpm)

    onset_index = {o.onsetId: o for o in onsets}
    group_index = {g.id: g for g in groups}
    anchors = collect_matched_beats(pairs0, onset_index, group_index, bpm_per_measure)
    if len(anchors) < max(3, int(0.5 * len(onsets))):
        # 锚点不足 → 无法可靠对齐
        raise LowConfidenceAlignmentError(
            f"可靠匹配过少（{len(anchors)}/{len(onsets)}），建议重录或缩短片段")

    tempo_map = fit_piecewise_tempo(anchors, bpm)
    pairs = global_align(onsets, groups, tempo_map, bpm_per_measure, bpm)

    final_anchors = collect_matched_beats(pairs, onset_index, group_index, bpm_per_measure)
    if len(final_anchors) < max(3, int(0.4 * len(onsets))):
        raise LowConfidenceAlignmentError(
            f"精对齐后可靠匹配仍不足（{len(final_anchors)}/{len(onsets)}）")

    # 3. 错误分类 / 模式 / 指标
    perf_by_id = {e.id: e for e in perf_events}
    group_pitch_onsets: dict[str, dict[int, float]] = {}
    for g in groups:
        po: dict[int, float] = {}
        for eid in g.eventIds:
            ev = perf_by_id.get(eid)
            if ev and (ev.pitch not in po or ev.tOnMs < po[ev.pitch]):
                po[ev.pitch] = ev.tOnMs
        group_pitch_onsets[g.id] = po
    errors, evidences = classify_errors(pairs, onset_index, group_index,
                                        tempo_map, bpm_per_measure, bpm,
                                        group_pitch_onsets)
    patterns = aggregate_patterns(errors)
    has_dynamics = any(e.dynamicTarget is not None for e in score_events)
    metrics: Metrics = calculate_metrics(pairs, onset_index, group_index,
                                         bpm_per_measure, bpm, has_dynamics)
    hypotheses = build_hypotheses(errors, patterns)

    return DiagnosisReport(
        reportId=report_id, sessionId=session_id, scoreId=meta.scoreId,
        metrics=metrics, errors=errors, evidences=evidences,
        patterns=patterns, hypotheses=hypotheses,
        scoreHash=meta.scoreHash, createdAt=created_at)
