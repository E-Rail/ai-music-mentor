"""微练习生成器（方案 5.8 / 10.3）：确定性规则生成。

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
import uuid
from pathlib import Path

from app.schemas.models import (DiagnosisReport, ErrorType, Exercise,
                                ExerciseParams, ScoreBundle, ScoreEvent)

STRATEGY_RULES = {
    ErrorType.wrong_pitch: "loop",
    ErrorType.missed_note: "loop",
    ErrorType.extra_note: "loop",
    ErrorType.early_late: "slow_ladder",
    ErrorType.tempo_instability: "slow_ladder",
    ErrorType.duration_anomaly: "rhythm_variant",
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
                    bundle: ScoreBundle, lead_in: int = 1) -> list[int]:
    """问题小节前加 lead_in 小节引导。"""
    if error_ids:
        sel = [e for e in report.errors if e.id in error_ids]
    else:
        sel = report.errors
    measures = sorted({e.location["measure"] for e in sel})
    if not measures:
        measures = [1]
    start = max(1, min(measures) - lead_in)
    end = min(bundle.meta.measureCount, max(measures))
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
    return [
        event.model_copy(update={"measureNo": measure_map[event.measureNo]})
        for event in events
    ]


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
                      out_dir: Path) -> Exercise:
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
        practice_events = _as_standalone_score(fragment)
        if not validate_well_formed(practice_events):
            raise ExerciseGenerationError("生成的乐谱结构不合法")
        events_to_musicxml(practice_events, meta, tempo,
                           f"微练习 · 第 {measures[0]}-{measures[-1]} 小节",
                           xml_path)
        events_to_midi(practice_events, meta, tempo, midi_path, repeat=repeat)

        return Exercise(
            exerciseId=exercise_id,
            sourceScoreId=meta.scoreId,
            sourceMeasures=measures,
            ruleId=strategy,
            params=params,
            musicXmlPath=str(xml_path),
            midiPath=str(midi_path),
            tempoPlan=tempo_plan)
    except Exception as e:  # noqa: BLE001 —— 降级：原片段+慢速+循环
        if isinstance(e, ExerciseGenerationError):
            reason = str(e)
        else:
            reason = f"生成异常: {e}"
        return _fallback(report, bundle, params, out_dir, reason)


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
              reason: str) -> Exercise:
    """EXERCISE_GENERATION_FAILED 降级：原片段 + 慢速 + 循环。"""
    from app.services.generation.score_build import (
        events_to_midi, events_to_musicxml)
    meta = bundle.meta
    measures = select_measures(report, params.errorIds, bundle, lead_in=1)
    fragment = _slice(bundle, measures)
    practice_events = _as_standalone_score(fragment)
    tempo = round(meta.tempo * 0.6)
    exercise_id = f"ex_{uuid.uuid4().hex[:10]}"
    xml_path = out_dir / f"{exercise_id}.musicxml"
    midi_path = out_dir / f"{exercise_id}.mid"
    events_to_musicxml(practice_events, meta, tempo,
                       f"降级练习 · 第 {measures[0]}-{measures[-1]} 小节", xml_path)
    events_to_midi(practice_events, meta, tempo, midi_path,
                   repeat=max(1, params.loopCount))
    fb_params = params.model_copy(update={"strategy": "loop"})
    return Exercise(
        exerciseId=exercise_id, sourceScoreId=meta.scoreId,
        sourceMeasures=measures, ruleId="loop_fallback",
        params=fb_params, musicXmlPath=str(xml_path),
        midiPath=str(midi_path),
        successCriterion=f"降级输出（{reason}）；达标：连续两次 pitchScore ≥ 95 且 MAE ≤ 120 ms")
