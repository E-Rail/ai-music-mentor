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

from dataclasses import dataclass

from app.schemas.models import (AlignmentPair, AlignOp, CaptureMeta,
                                DiagnosisReport, InputQuality,
                                InputSource, InstrumentProfile, Metrics,
                                PerformanceEvent, PerformanceGroup, ScoreBundle,
                                ScoreEvent)
from app.services.alignment.align import (collect_matched_beats,
                                          collect_paired_beats, global_align,
                                          pitch_set_distance)
from app.services.alignment.grouping import group_chord_onsets
from app.services.alignment.onset import (ScoreOnset, build_onsets,
                                          score_onset_beat)
from app.services.alignment.tempo import fit_piecewise_tempo, initial_tempo_map
from app.services.diagnosis.errors import classify_errors
from app.services.diagnosis.metrics import calculate_metrics
from app.services.diagnosis.patterns import aggregate_patterns, build_hypotheses
from app.services.diagnosis.profiles import accepted_events, resolve_profile


class LowConfidenceAlignmentError(Exception):
    """ALIGNMENT_LOW_CONFIDENCE：整体无法可靠对齐，不给确定性评分。"""


@dataclass(frozen=True)
class _AlignmentQuality:
    confidence: float
    paired_count: int
    score_coverage: float
    performance_coverage: float
    timing_inlier_ratio: float
    pitch_similarity: float


def _alignment_quality(
        pairs: list[AlignmentPair],
        onset_index: dict[str, ScoreOnset],
        group_index: dict[str, PerformanceGroup],
        bpm: float,
) -> _AlignmentQuality:
    """Measure path stability without treating wrong pitches as path failure.

    Coverage and timing own most of this score. Pitch overlap contributes only
    a small amount because pitch mistakes are precisely what diagnosis needs to
    report, not a reason to throw away an otherwise coherent performance.
    """
    paired = [pair for pair in pairs
              if pair.operation in (AlignOp.match, AlignOp.substitute)
              and pair.scoreEventId in onset_index
              and pair.performanceId in group_index]
    if not paired:
        return _AlignmentQuality(0.0, 0, 0.0, 0.0, 0.0, 0.0)
    score_coverage = len({pair.scoreEventId for pair in paired}) / max(1, len(onset_index))
    performance_coverage = len({pair.performanceId for pair in paired}) / max(1, len(group_index))
    beat_ms = 60_000.0 / max(1.0, bpm)
    timing_inlier_ratio = sum(
        1 for pair in paired if abs(pair.onsetResidualMs) <= 0.75 * beat_ms
    ) / len(paired)
    pitch_similarity = sum(
        1.0 - pitch_set_distance(
            onset_index[pair.scoreEventId or ""].pitches,
            group_index[pair.performanceId or ""].pitches,
        )
        for pair in paired
    ) / len(paired)
    coverage = min(score_coverage, performance_coverage)
    confidence = coverage * (
        0.55 + 0.30 * timing_inlier_ratio + 0.15 * pitch_similarity)
    return _AlignmentQuality(
        confidence=round(max(0.0, min(1.0, confidence)), 3),
        paired_count=len(paired),
        score_coverage=score_coverage,
        performance_coverage=performance_coverage,
        timing_inlier_ratio=timing_inlier_ratio,
        pitch_similarity=pitch_similarity,
    )


def filter_range(events: list[ScoreEvent], start: int, end: int) -> list[ScoreEvent]:
    end = end if end > 0 else 10 ** 9
    return [e for e in events if start <= e.measureNo <= end]


def _limited_evidence_report(
        bundle: ScoreBundle,
        score_events: list[ScoreEvent],
        perf_events: list[PerformanceEvent],
        report_id: str,
        session_id: str,
        source: InputSource,
        instrument: InstrumentProfile,
        profile_id: str,
        capture_meta: CaptureMeta,
        rejected_count: int,
        reason: str,
        created_at: str,
) -> DiagnosisReport:
    """Complete a microphone take even when it cannot support musical scoring.

    A weak or silent take is still a valid captured artifact.  Returning an
    immutable quality-only report keeps the UI out of a retry loop while making
    it impossible to mistake missing evidence for a good (or bad) performance.
    """
    confidences = [event.transcriptionConfidence for event in perf_events
                   if event.transcriptionConfidence is not None]
    mean_confidence = (
        capture_meta.meanConfidence
        if capture_meta.meanConfidence is not None
        else (sum(confidences) / len(confidences) if confidences else 0.0)
    )
    accepted_count = len(perf_events)
    warnings = [
        "录音已接收并完成处理，但当前证据不足，未生成演奏分数或错误判断。",
        reason,
        "你可以直接查看本次结果、询问 AI 导师，或在更靠近乐器的位置再次录制。",
    ]
    if capture_meta.noiseFloorDb is not None and capture_meta.noiseFloorDb > -25:
        warnings.append("环境底噪较高；建议关闭扬声器伴奏并把麦克风靠近乐器。")
    return DiagnosisReport(
        reportId=report_id,
        sessionId=session_id,
        scoreId=bundle.meta.scoreId,
        metrics=Metrics(
            pitchScore=0, rhythmScore=0, fluencyScore=0, dynamicsScore=0,
            overallScore=0, timingMaeMs=0, avgBpm=0,
            matchedCount=0, expectedCount=len(score_events),
        ),
        errors=[], evidences=[], patterns=[], hypotheses=[],
        thresholdProfile=profile_id,
        inputQuality=InputQuality(
            source=source, instrument=instrument, status="insufficient",
            confidence=round(max(0.0, min(1.0, mean_confidence)), 3),
            acceptedNoteCount=accepted_count,
            rejectedNoteCount=max(rejected_count, capture_meta.rejectedNoteCount),
            noiseFloorDb=capture_meta.noiseFloorDb,
            transcriptionEngine=capture_meta.transcriptionEngine,
            transcriptionVersion=capture_meta.transcriptionVersion,
        ),
        warnings=list(dict.fromkeys(warnings)),
        scoreHash=bundle.meta.scoreHash,
        createdAt=created_at,
    )


def run_analysis(bundle: ScoreBundle,
                 perf_events: list[PerformanceEvent],
                 report_id: str,
                 session_id: str,
                 range_start: int = 1,
                 range_end: int = 0,
                 created_at: str = "",
                 input_source: InputSource | str = InputSource.web_midi,
                 instrument: InstrumentProfile | str = InstrumentProfile.piano,
                 capture_meta: CaptureMeta | dict | None = None) -> DiagnosisReport:
    meta = bundle.meta
    score_events = filter_range(bundle.events, range_start, range_end)
    if not score_events:
        raise LowConfidenceAlignmentError("练习范围内没有乐谱事件")

    source = InputSource(input_source)
    selected_instrument = InstrumentProfile(instrument)
    profile = resolve_profile(source, selected_instrument)
    meta_capture = (capture_meta if isinstance(capture_meta, CaptureMeta)
                    else CaptureMeta.model_validate(capture_meta or {}))
    if not perf_events:
        if source == InputSource.microphone:
            return _limited_evidence_report(
                bundle, score_events, [], report_id, session_id, source,
                selected_instrument, profile.profile_id, meta_capture,
                meta_capture.rejectedNoteCount,
                "没有检测到足够清晰的音符；这不会丢弃录音。",
                created_at,
            )
        raise LowConfidenceAlignmentError("没有演奏事件，请重录或缩短片段")

    perf_events, profile_rejected = accepted_events(perf_events, profile)
    guitar_pitch_offset = 0
    if (source == InputSource.microphone and
            selected_instrument == InstrumentProfile.guitar and
            meta.writtenToSoundingSemitones):
        guitar_pitch_offset = meta.writtenToSoundingSemitones
        perf_events = [event.model_copy(update={
            "pitch": event.pitch - guitar_pitch_offset,
        }) for event in perf_events
                       if 0 <= event.pitch - guitar_pitch_offset <= 127]
    if not perf_events:
        if source == InputSource.microphone:
            return _limited_evidence_report(
                bundle, score_events, [], report_id, session_id, source,
                selected_instrument, profile.profile_id, meta_capture,
                profile_rejected,
                "检测到的片段都低于当前乐器配置的可靠阈值；这不会丢弃录音。",
                created_at,
            )
        raise LowConfidenceAlignmentError("没有可用于分析的演奏事件，请重录")
    if source == InputSource.microphone and len(perf_events) < 3:
        return _limited_evidence_report(
            bundle, score_events, perf_events, report_id, session_id, source,
            selected_instrument, profile.profile_id, meta_capture,
            profile_rejected,
            "可靠音符少于 3 个，因此本轮只展示输入质量，不做确定性评分。",
            created_at,
        )

    bpm, bpm_per_measure = meta.tempo, meta.beatsPerMeasure

    # 1. 乐谱 onset 聚类 + 演奏和弦分组（慢速曲窗口上调）
    onsets = build_onsets(score_events)
    groups = group_chord_onsets(perf_events, window_ms=profile.chord_window_ms, bpm=bpm)

    # 2. 两遍对齐：无门限的容错序列粗对齐 → 速度拟合 → 精对齐。
    #    粗对齐故意允许错音通过；音高错误是待诊断事实，不是全局失败条件。
    #    初始速度用"总时长/总拍数"估计，可容忍 ±30% 的整体快慢（global_slow 场景）
    first = onsets[0]
    last = onsets[-1]
    first_beat = score_onset_beat(first, bpm_per_measure)
    last_beat = score_onset_beat(last, bpm_per_measure)
    span_ms = groups[-1].tOnMs - groups[0].tOnMs
    span_beats = max(0.5, last_beat - first_beat)
    est_bpm = bpm
    if span_ms > 0:
        est_spb = span_ms / span_beats / 1000.0
        nominal_spb = 60.0 / bpm
        if 0.6 * nominal_spb <= est_spb <= 1.8 * nominal_spb:
            est_bpm = 60.0 / est_spb
    tmap0 = initial_tempo_map(first_beat, groups[0].tOnMs, est_bpm)
    pairs0 = global_align(
        onsets, groups, tmap0, bpm_per_measure, bpm,
        gate_beats=None, onset_weight=0.08,
    )

    onset_index = {o.onsetId: o for o in onsets}
    group_index = {g.id: g for g in groups}
    anchors = collect_matched_beats(pairs0, onset_index, group_index, bpm_per_measure)
    paired_timing = collect_paired_beats(
        pairs0, onset_index, group_index, bpm_per_measure)
    # Exact/near-exact pitch anchors remain the safest tempo source. When the
    # player makes many pitch mistakes, structural pairs provide timing-only
    # anchors so those mistakes can still be localized.
    tempo_anchors = anchors if len(anchors) >= 3 else paired_timing
    tempo_map = (fit_piecewise_tempo(tempo_anchors, bpm)
                 if len(tempo_anchors) >= 2 else tmap0)
    pairs = global_align(
        onsets, groups, tempo_map, bpm_per_measure, bpm,
        gate_beats=1.5,
    )
    alignment_quality = _alignment_quality(
        pairs, onset_index, group_index, bpm)
    # Microphone transcription can still be too sparse to support score-level
    # claims. MIDI is never discarded merely because pitches were wrong: the
    # deterministic path returns localized low-confidence errors instead.
    if (source == InputSource.microphone and
            (alignment_quality.paired_count < 3 or
             alignment_quality.score_coverage < 0.20 or
             alignment_quality.confidence < 0.18)):
        return _limited_evidence_report(
            bundle, score_events, perf_events, report_id, session_id, source,
            selected_instrument, profile.profile_id, meta_capture,
            profile_rejected,
            (f"只对齐到 {alignment_quality.paired_count}/{len(onsets)} 个谱面拍点；"
             "录音已保留，但其余位置不生成推测性错误。"),
            created_at,
        )

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
    # Dynamics may only be judged when the page actually asks for a dynamic and
    # the input can measure one. A microphone reports Basic Pitch amplitude,
    # which is not MIDI velocity and must not be graded as if it were.
    input_measures_dynamics = source != InputSource.microphone
    has_dynamics = (meta.hasNotatedDynamics and
                    any(e.dynamicTarget is not None for e in score_events))
    grade_dynamics = has_dynamics and input_measures_dynamics
    errors, evidences = classify_errors(pairs, onset_index, group_index,
                                        tempo_map, bpm_per_measure, bpm,
                                        group_pitch_onsets,
                                        include_duration_errors=profile.include_duration_errors,
                                        duration_tolerance=profile.duration_tolerance,
                                        include_dynamics_errors=input_measures_dynamics,
                                        has_notated_dynamics=has_dynamics)
    patterns = aggregate_patterns(errors)
    metrics: Metrics = calculate_metrics(pairs, onset_index, group_index,
                                         bpm_per_measure, bpm, grade_dynamics)
    hypotheses = build_hypotheses(errors, patterns)

    event_confidences = [event.transcriptionConfidence for event in perf_events
                         if event.transcriptionConfidence is not None]
    mean_confidence = (meta_capture.meanConfidence if meta_capture.meanConfidence is not None
                       else (sum(event_confidences) / len(event_confidences)
                             if event_confidences else 1.0))
    rejected_count = max(meta_capture.rejectedNoteCount, profile_rejected)
    accepted_count = len(perf_events)
    rejection_ratio = rejected_count / max(1, accepted_count + rejected_count)
    warnings: list[str] = []
    tolerant_operation_count = sum(
        1 for pair in pairs if pair.operation != AlignOp.match)
    if tolerant_operation_count:
        warnings.append(
            "已使用容错序列对齐：错音、多音和漏音只影响对应位置，不会拖移后续检测。")
    if grade_dynamics:
        warnings.append(
            "力度按谱面标记的强弱记号逐音比较；力度差只影响对应位置。")
    if alignment_quality.confidence < 0.45:
        warnings.append(
            "本次对齐覆盖偏低；已生成可定位的逐音错误，但未匹配区域请按低置信度解读。")
    quality_status = ("high" if alignment_quality.confidence >= 0.75 else
                      "medium" if alignment_quality.confidence >= 0.45 else "low")
    quality_confidence = alignment_quality.confidence
    if source == InputSource.microphone:
        if meta_capture.lowVolumeRecovered:
            warnings.append(
                f"检测到输入音量偏低，已仅为本地识别增加约 {meta_capture.inputGainDb or 0:.1f} dB；原始录音未被替换。")
        quality_confidence = min(mean_confidence, alignment_quality.confidence)
        if guitar_pitch_offset:
            warnings.append(
                "已按乐谱中的吉他八度移调标记，将实声音高换算为书写音高。")
        if (mean_confidence < 0.45 or accepted_count < 5 or
                alignment_quality.confidence < 0.35):
            quality_status = "low"
            warnings.append("输入质量偏低；请把麦克风靠近乐器并在安静环境中重录。")
        elif (mean_confidence < 0.68 or rejection_ratio > 0.35 or
              alignment_quality.confidence < 0.65):
            quality_status = "medium"
            warnings.append("部分音符的转录置信度较低，结论应结合谱面证据谨慎解读。")
        if meta_capture.noiseFloorDb is not None and meta_capture.noiseFloorDb > -25:
            quality_status = "low"
            warnings.append("环境底噪较高，建议关闭扬声器伴奏并重新录制。")
        # Confidence belongs to the transcription, not the musical rule. Keep
        # deterministic classifications but make their uncertainty visible.
        for error in errors:
            error.confidence = round(
                error.confidence * max(0.45, mean_confidence)
                * max(0.55, alignment_quality.confidence), 3)
    elif alignment_quality.confidence < 0.75:
        for error in errors:
            error.confidence = round(
                error.confidence * max(0.45, alignment_quality.confidence), 3)

    return DiagnosisReport(
        reportId=report_id, sessionId=session_id, scoreId=meta.scoreId,
        metrics=metrics, errors=errors, evidences=evidences,
        patterns=patterns, hypotheses=hypotheses,
        thresholdProfile=profile.profile_id,
        inputQuality=InputQuality(
            source=source, instrument=selected_instrument,
            status=quality_status, confidence=round(quality_confidence, 3),
            acceptedNoteCount=accepted_count, rejectedNoteCount=rejected_count,
            noiseFloorDb=meta_capture.noiseFloorDb,
            transcriptionEngine=meta_capture.transcriptionEngine,
            transcriptionVersion=meta_capture.transcriptionVersion,
        ),
        warnings=warnings, scoreHash=meta.scoreHash, createdAt=created_at)
