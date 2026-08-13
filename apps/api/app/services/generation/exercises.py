"""微练习生成器：确定性、可追踪的多终止式发展练习。

策略：
- loop            片段循环：问题小节前加 1 小节引导，循环 3–5 次
- slow_ladder     慢速阶梯：原速 60% 起，每次达标 +5 BPM
- hands_separate  拆手练习：保留目标声部
- rhythm_variant  节奏变体：附点长-短变体
- beat_skeleton   节拍骨架：只保留每拍主音

生成失败降级为「原片段 + 慢速 + 循环」，保证现场始终有输出。
"""
from __future__ import annotations

import copy
import hashlib
import json
import uuid
from pathlib import Path

from app.schemas.models import (DiagnosisReport, ErrorType, Exercise,
                                ExerciseParams, ScoreBundle, ScoreEvent)

STRATEGY_RULES = {
    ErrorType.wrong_pitch: "chunk_connect",
    ErrorType.missed_note: "chunk_connect",
    ErrorType.extra_note: "chunk_connect",
    ErrorType.early_late: "slow_ladder",
    ErrorType.tempo_instability: "slow_ladder",
    ErrorType.duration_anomaly: "rhythm_variant",
    ErrorType.dynamics_anomaly: "chunk_connect",
}


class ExerciseGenerationError(Exception):
    pass


def suggest_strategy(report: DiagnosisReport) -> str:
    """按最高优先级错误类型推荐策略。"""
    if not report.errors:
        return "loop"
    sev_rank = {"high": 0, "medium": 1, "low": 2}
    top = sorted(report.errors,
                 key=lambda e: (sev_rank.get(e.severity.value, 3),
                                -e.confidence))[0]
    return STRATEGY_RULES.get(top.type, "loop")


def select_measures(report: DiagnosisReport, error_ids: list[str],
                    bundle: ScoreBundle, lead_in: int = 1,
                    min_measures: int = 2,
                    max_measures: int = 4) -> list[int]:
    """Select a focused context window, never a stranded one-note measure."""
    if error_ids:
        sel = [e for e in report.errors if e.id in error_ids]
    else:
        sel = report.errors
    measures = sorted({e.location["measure"] for e in sel})
    if not measures:
        measures = [1]
    anchor = measures[0]
    start = max(1, anchor - lead_in)
    desired_end = max(measures)
    end = min(bundle.meta.measureCount, max(desired_end, start + min_measures - 1))
    if end - start + 1 < min_measures:
        start = max(1, end - min_measures + 1)
    if end - start + 1 > max_measures:
        end = start + max_measures - 1
    return list(range(start, end + 1))


def _slice(bundle: ScoreBundle, measures: list[int]) -> list[ScoreEvent]:
    return [copy.deepcopy(e) for e in bundle.events
            if e.measureNo in measures and not e.optional]


def _as_standalone_score(events: list[ScoreEvent]) -> list[ScoreEvent]:
    """Renumber a generated fragment so it behaves like an independent score."""
    measure_map = {
        source: generated
        for generated, source in enumerate(sorted({event.measureNo for event in events}), 1)
    }
    standalone = []
    for index, event in enumerate(events):
        standalone.append(event.model_copy(update={
            "measureNo": measure_map[event.measureNo],
            "eventId": f"practice:m{measure_map[event.measureNo]}:{index}",
        }))
    return standalone


_INSTRUMENT_RANGES = {
    "piano": (21, 108),
    "guitar": (40, 88),
    "violin": (55, 103),
}

_CADENCE_ORDERS = [
    ["half", "deceptive", "plagal", "authentic"],
    ["deceptive", "half", "plagal", "authentic"],
    ["plagal", "deceptive", "half", "authentic"],
    ["half", "plagal", "deceptive", "authentic"],
    ["deceptive", "plagal", "half", "authentic"],
    ["plagal", "half", "deceptive", "authentic"],
]

_CADENCE_LABELS = {
    "half": "半终止",
    "deceptive": "阻碍终止",
    "plagal": "变格终止",
    "authentic": "正格终止",
}

# Scale-degree triads. The first interval is the harmonic root and is used for
# monophonic material; chordal source events retain their original note count.
_MAJOR_TRIADS = {
    "I": (0, 4, 7), "ii": (2, 5, 9), "IV": (5, 9, 0),
    "V": (7, 11, 2), "vi": (9, 0, 4),
}
_MINOR_TRIADS = {
    "I": (0, 3, 7), "ii": (2, 5, 8), "IV": (5, 8, 0),
    "V": (7, 11, 2), "vi": (8, 0, 3),
}
_CADENCE_PROGRESSIONS = {
    "half": ("ii", "V"),
    "deceptive": ("V", "vi"),
    "plagal": ("IV", "I"),
    "authentic": ("ii", "V", "I"),
}


def cadence_plan_for_variation(variation_index: int) -> list[str]:
    return list(_CADENCE_ORDERS[variation_index % len(_CADENCE_ORDERS)])


def _infer_key(events: list[ScoreEvent]) -> tuple[int, bool]:
    """Infer a stable major/minor center from duration-weighted pitch classes."""
    histogram = [0.0] * 12
    for event in events:
        weight = max(0.125, event.durationBeat) / max(1, len(event.pitches))
        for pitch in event.pitches:
            histogram[pitch % 12] += weight
    if not any(histogram):
        return 0, False
    major_profile = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                     2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
    minor_profile = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                     2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
    final_pitch_class = None
    if events:
        last = max(events, key=lambda event: (event.measureNo, event.onsetBeat))
        if last.pitches:
            final_pitch_class = min(last.pitches) % 12

    candidates: list[tuple[float, int, bool]] = []
    for tonic in range(12):
        for is_minor, profile in ((False, major_profile), (True, minor_profile)):
            score = sum(
                histogram[pitch_class] * profile[(pitch_class - tonic) % 12]
                for pitch_class in range(12)
            )
            if final_pitch_class == tonic:
                score += max(histogram) * 1.25
            candidates.append((score, tonic, is_minor))
    _, tonic, is_minor = max(candidates, key=lambda candidate: candidate[0])
    return tonic, is_minor


def _nearest_pitch(pitch: int, pitch_class: int, low: int, high: int,
                   used: set[int]) -> int:
    options = [candidate for candidate in range(low, high + 1)
               if candidate % 12 == pitch_class and candidate not in used]
    if not options:
        options = [candidate for candidate in range(low, high + 1)
                   if candidate % 12 == pitch_class]
    return min(options, key=lambda candidate: (abs(candidate - pitch), candidate))


def _voice_cadence_event(event: ScoreEvent, chord_intervals: tuple[int, ...],
                         tonic: int, instrument: str) -> None:
    low, high = _INSTRUMENT_RANGES.get(instrument, (21, 108))
    source = sorted(event.pitches)
    if not source:
        return
    # Solo melodic material states the cadence root clearly. Existing chords
    # keep their density and are re-voiced to the nearest chord tones.
    target_classes = [
        (tonic + chord_intervals[index % len(chord_intervals)]) % 12
        for index in range(len(source))
    ]
    used: set[int] = set()
    voiced = []
    for pitch, pitch_class in zip(source, target_classes):
        target = _nearest_pitch(pitch, pitch_class, low, high, used)
        used.add(target)
        voiced.append(target)
    event.pitches = sorted(voiced)


def _apply_cadence(event_list: list[ScoreEvent], measure: int,
                   cadence: str, tonic: int, is_minor: bool,
                   instrument: str) -> None:
    measure_events = [event for event in event_list if event.measureNo == measure]
    if not measure_events:
        return
    onsets = sorted({event.onsetBeat for event in measure_events})
    degrees = _CADENCE_PROGRESSIONS[cadence]
    selected_onsets = onsets[-min(len(onsets), len(degrees)):]
    selected_degrees = degrees[-len(selected_onsets):]
    triads = _MINOR_TRIADS if is_minor else _MAJOR_TRIADS
    for onset, degree in zip(selected_onsets, selected_degrees):
        for event in measure_events:
            if abs(event.onsetBeat - onset) < 1e-6:
                _voice_cadence_event(
                    event, triads[degree], tonic, instrument)


def _safe_shift(events: list[ScoreEvent], requested: int,
                instrument: str) -> int:
    low, high = _INSTRUMENT_RANGES.get(instrument, (21, 108))
    pitches = [pitch for event in events for pitch in event.pitches]
    if not pitches:
        return 0
    candidates = [requested, -requested, 2, -2, 3, -3, 5, -5, 0]
    for shift in candidates:
        if min(pitches) + shift >= low and max(pitches) + shift <= high:
            return shift
    return 0


def _ensure_developed_length(events: list[ScoreEvent],
                             min_measures: int = 5) -> list[ScoreEvent]:
    """Repeat a short source motif only as raw material for a varied answer."""
    out = [copy.deepcopy(event) for event in events]
    measures = sorted({event.measureNo for event in out})
    if not measures:
        return out
    source_measures = list(measures)
    clone_index = 0
    while len({event.measureNo for event in out}) < min_measures:
        source_measure = source_measures[clone_index % len(source_measures)]
        clone_index += 1
        next_measure = max(event.measureNo for event in out) + 1
        clones = [copy.deepcopy(event) for event in out
                  if event.measureNo == source_measure]
        for index, event in enumerate(clones):
            event.measureNo = next_measure
            event.eventId = f"{event.eventId}:development:{next_measure}:{index}"
        out.extend(clones)
    return out


def _develop_fragment(events: list[ScoreEvent], variation_index: int,
                      instrument: str,
                      tonal_context: list[ScoreEvent] | None = None) -> list[ScoreEvent]:
    """Develop one motif through contrasting cadences and a force contour."""
    developed = _ensure_developed_length(events)
    measures = sorted({event.measureNo for event in developed})
    if not measures:
        return developed
    shifts = [2, -2, 3, -3, 5, -5]
    requested = shifts[variation_index % len(shifts)]
    cadence_plan = cadence_plan_for_variation(variation_index)
    cadence_measures = measures[-len(cadence_plan):]
    answer_events = [event for event in developed
                     if event.measureNo in cadence_measures]
    shift = _safe_shift(answer_events, requested, instrument)
    for event in answer_events:
        event.pitches = [pitch + shift for pitch in event.pitches]

    # Infer harmony from the whole target score when available. A two-measure
    # error window alone can easily resemble a different key.
    tonic, is_minor = _infer_key(tonal_context or events)
    for measure, cadence in zip(cadence_measures, cadence_plan):
        _apply_cadence(
            developed, measure, cadence, tonic, is_minor, instrument)

    # Make every generated MIDI carry a deliberate, playable force contour.
    # The target is also written back to MusicXML as dynamics, so a retry can
    # be compared against the exact same velocity evidence.
    for event in developed:
        measure_index = measures.index(event.measureNo)
        beat_accent = 9 if abs(event.onsetBeat - round(event.onsetBeat)) < 1e-6 else -3
        downbeat = 5 if event.onsetBeat < 0.01 else 0
        phrase_shape = (measure_index * 4) - (len(measures) - 1) * 2
        variant_shape = ((variation_index + measure_index) % 3 - 1) * 3
        generation_shape = (variation_index // len(shifts)) % 7 * 2
        base = event.dynamicTarget if event.dynamicTarget is not None else 68
        event.dynamicTarget = max(28, min(
            112, round(base + beat_accent + downbeat + phrase_shape +
                       variant_shape + generation_shape)))
    for index, event in enumerate(sorted(
            developed, key=lambda item: (item.measureNo, item.onsetBeat, item.part))):
        event.eventId = f"practice:v{variation_index}:m{event.measureNo}:{index}"
    return developed


def musical_fingerprint(events: list[ScoreEvent]) -> str:
    """Hash musical content rather than generated IDs or titles."""
    canonical = [{
        "measure": event.measureNo,
        "beat": round(event.onsetBeat, 5),
        "duration": round(event.durationBeat, 5),
        "pitches": sorted(event.pitches),
        "part": event.part,
        "dynamic": event.dynamicTarget,
    } for event in sorted(events, key=lambda item: (
        item.measureNo, item.onsetBeat, item.part, item.pitches))]
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()[:24]


def _apply_rhythm_variant(events: list[ScoreEvent]) -> list[ScoreEvent]:
    """附点长-短变体：同一拍内两个八分音 → 3/4 + 1/4 拍。"""
    by_pair: dict[tuple, list[ScoreEvent]] = {}
    for e in events:
        key = (e.measureNo, int(e.onsetBeat), e.part)
        by_pair.setdefault(key, []).append(e)
    for (m, beat, part), group in by_pair.items():
        group.sort(key=lambda e: e.onsetBeat)
        if (len(group) == 2
                and all(abs(e.durationBeat - 0.5) < 1e-6 for e in group)
                and abs(group[1].onsetBeat - group[0].onsetBeat - 0.5) < 1e-6):
            group[0].durationBeat = 0.75
            group[1].durationBeat = 0.25
            group[1].onsetBeat = group[0].onsetBeat + 0.75
    return events


def _apply_beat_skeleton(events: list[ScoreEvent]) -> list[ScoreEvent]:
    """只保留每拍第一个 onset（拍点骨架）。"""
    seen: set[tuple[int, int, str]] = set()
    out = []
    for e in sorted(events, key=lambda x: (x.measureNo, x.onsetBeat)):
        key = (e.measureNo, int(e.onsetBeat), e.part)
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def generate_exercise(report: DiagnosisReport,
                      bundle: ScoreBundle,
                      params: ExerciseParams,
                      out_dir: Path,
                      variation_index: int = 0) -> Exercise:
    """generateExercise 主流程（方案 10.3 伪代码）。"""
    meta = bundle.meta
    try:
        measures = select_measures(report, params.errorIds, bundle, lead_in=1)
        fragment = _slice(bundle, measures)
        if not fragment:
            raise ExerciseGenerationError("目标小节没有可练习事件")

        strategy = params.strategy
        tempo = meta.tempo
        tempo_plan: list[float] = []
        repeat = 1

        if strategy == "slow_ladder":
            tempo = round(meta.tempo * params.tempoRatio)
            tempo_plan = []
            t = tempo
            while t < meta.tempo:
                tempo_plan.append(float(t))
                t += 5
            tempo_plan.append(meta.tempo)
            repeat = max(1, params.loopCount)
        elif strategy == "hands_separate":
            target_part = params.hands or _dominant_part(report, bundle)
            fragment = [e for e in fragment if e.part == target_part]
            if not fragment:
                raise ExerciseGenerationError("目标声部在所选小节没有事件")
            repeat = max(1, params.loopCount)
        elif strategy == "rhythm_variant":
            fragment = _apply_rhythm_variant(fragment)
            tempo = round(meta.tempo * max(params.tempoRatio, 0.7))
            repeat = max(1, params.loopCount)
        elif strategy == "beat_skeleton":
            fragment = _apply_beat_skeleton(fragment)
            repeat = max(1, params.loopCount)
        elif strategy == "chunk_connect":
            repeat = 1  # A 两拍、B 两拍、A+B 由前端分段任务呈现
        else:  # loop 与未知策略的默认
            strategy = "loop"
            repeat = max(1, params.loopCount)

        exercise_id = f"ex_{uuid.uuid4().hex[:10]}"
        xml_path = out_dir / f"{exercise_id}.musicxml"
        midi_path = out_dir / f"{exercise_id}.mid"

        from app.services.generation.score_build import (
            events_to_midi, events_to_musicxml, validate_well_formed)

        # The persisted generated score is a standalone piece numbered from
        # measure 1. Playback repetition remains a MIDI concern.
        practice_events = _develop_fragment(
            _as_standalone_score(fragment), variation_index,
            report.inputQuality.instrument.value, bundle.events)
        cadence_plan = cadence_plan_for_variation(variation_index)
        if not validate_well_formed(practice_events):
            raise ExerciseGenerationError("生成的乐谱结构不合法")
        cadence_title = " → ".join(_CADENCE_LABELS[item]
                                   for item in cadence_plan)
        events_to_musicxml(practice_events, meta, tempo,
                           f"多终止式练习 · {cadence_title}",
                           xml_path, report.inputQuality.instrument)
        events_to_midi(practice_events, meta, tempo, midi_path, repeat=repeat)
        fingerprint = musical_fingerprint(practice_events)
        selected_errors = ([error for error in report.errors
                            if error.id in params.errorIds]
                           if params.errorIds else report.errors[:1])
        success_criterion = (
            "连续两次 pitchScore ≥ 95、timing MAE ≤ 120 ms 且 dynamicsScore ≥ 85"
            if any(error.type == ErrorType.dynamics_anomaly
                   for error in selected_errors)
            else "连续两次 pitchScore ≥ 95 且 timing MAE ≤ 120 ms"
        )

        return Exercise(
            exerciseId=exercise_id,
            sourceScoreId=meta.scoreId,
            sourceMeasures=measures,
            ruleId=strategy,
            params=params,
            musicXmlPath=str(xml_path),
            midiPath=str(midi_path),
            tempoPlan=tempo_plan,
            successCriterion=success_criterion,
            variationIndex=variation_index,
            musicalFingerprint=fingerprint,
            cadencePlan=cadence_plan)
    except Exception as e:  # noqa: BLE001 —— 降级：原片段+慢速+循环
        if isinstance(e, ExerciseGenerationError):
            reason = str(e)
        else:
            reason = f"生成异常: {e}"
        return _fallback(
            report, bundle, params, out_dir, reason, variation_index)


def _dominant_part(report: DiagnosisReport, bundle: ScoreBundle) -> str:
    """错误集中的声部。"""
    part_votes: dict[str, int] = {}
    ev_by_id = {e.eventId: e for e in bundle.events}
    for err in report.errors:
        for eid in err.location.get("eventIds") or []:
            ev = ev_by_id.get(eid)
            if ev:
                part_votes[ev.part] = part_votes.get(ev.part, 0) + 1
    return max(part_votes, key=part_votes.get) if part_votes else "RH"


def _fallback(report: DiagnosisReport, bundle: ScoreBundle,
              params: ExerciseParams, out_dir: Path,
              reason: str, variation_index: int = 0) -> Exercise:
    """EXERCISE_GENERATION_FAILED 降级：原片段 + 慢速 + 循环。"""
    from app.services.generation.score_build import (
        events_to_midi, events_to_musicxml)
    meta = bundle.meta
    measures = select_measures(report, params.errorIds, bundle, lead_in=1)
    fragment = _slice(bundle, measures)
    practice_events = _develop_fragment(
        _as_standalone_score(fragment), variation_index,
        report.inputQuality.instrument.value, bundle.events)
    cadence_plan = cadence_plan_for_variation(variation_index)
    tempo = round(meta.tempo * 0.6)
    exercise_id = f"ex_{uuid.uuid4().hex[:10]}"
    xml_path = out_dir / f"{exercise_id}.musicxml"
    midi_path = out_dir / f"{exercise_id}.mid"
    cadence_title = " → ".join(_CADENCE_LABELS[item]
                               for item in cadence_plan)
    events_to_musicxml(practice_events, meta, tempo,
                       f"多终止式降级练习 · {cadence_title}", xml_path,
                       report.inputQuality.instrument)
    events_to_midi(practice_events, meta, tempo, midi_path,
                   repeat=max(1, params.loopCount))
    fb_params = params.model_copy(update={"strategy": "loop"})
    return Exercise(
        exerciseId=exercise_id, sourceScoreId=meta.scoreId,
        sourceMeasures=measures, ruleId="loop_fallback",
        params=fb_params, musicXmlPath=str(xml_path),
        midiPath=str(midi_path),
        successCriterion=f"降级输出（{reason}）；达标：连续两次 pitchScore ≥ 95 且 MAE ≤ 120 ms",
        variationIndex=variation_index,
        musicalFingerprint=musical_fingerprint(practice_events),
        cadencePlan=cadence_plan)
