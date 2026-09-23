"""AI 导师（方案 5.10）：规则模板实现（MENTOR_PROVIDER=rules 及 LLM 降级兜底）。

输入是诊断摘要（DiagnosisPayload），不接触原始乐谱/音频。
输出固定 MentorResponse Schema；不得修改 errorType、位置和数值；
建议必须引用 evidence；无视频时禁止断言手型/指法。
"""
from __future__ import annotations

from app.i18n import say
from app.schemas.models import (DiagnosisReport, ErrorType, MentorChatResponse,
                                MentorResponse)

# (exercise type, message key naming it)
STRATEGY_BY_TYPE = {
    ErrorType.wrong_pitch: ("chunk_connect", "strategy.chunk_connect"),
    ErrorType.missed_note: ("chunk_connect", "strategy.chunk_connect"),
    ErrorType.extra_note: ("chunk_connect", "strategy.chunk_connect"),
    ErrorType.early_late: ("slow_ladder", "strategy.slow_ladder"),
    ErrorType.tempo_instability: ("slow_ladder", "strategy.slow_ladder"),
    ErrorType.duration_anomaly: ("rhythm_variant", "strategy.rhythm_variant"),
    ErrorType.dynamics_anomaly: ("chunk_connect", "strategy.dynamics_chunk"),
}

# The fallback reads intent from words, and a player may type in either
# language whatever the interface is set to — so every list holds both.
# They are matched against questions, never shown, so they stay out of the
# catalogue on purpose.
THEORY_WORDS = (  # i18n: deliberate
    "和弦", "音阶", "调式", "theory", "chord", "scale", "key signature")
TECHNIQUE_WORDS = (  # i18n: deliberate
    "手型", "指法", "姿势", "技巧", "bow", "fingering", "posture",
    "technique", "hand position")
PRACTICE_WORDS = (  # i18n: deliberate
    "怎么练", "如何练", "练习计划", "提高", "改进", "practice",
    "plan", "improve", "how do i", "how should i")
WHY_WORDS = (  # i18n: deliberate
    "为什么", "为啥", "原因", "why", "cause", "reason")
SCORE_WORDS = (  # i18n: deliberate
    "分数", "多少分", "评价", "怎么样", "报告", "score", "report", "how did i")


def _type_label(error_type: ErrorType) -> str:
    return say(f"type.{error_type.value}")


def _sev_rank(s: str) -> int:
    return {"high": 0, "medium": 1, "low": 2}.get(s, 3)


def _mentions(text: str, words: tuple[str, ...]) -> bool:
    lower = text.lower()
    return any(word in lower for word in words)


def build_response(report: DiagnosisReport,
                   selected_error_id: str | None = None) -> MentorResponse:
    m = report.metrics
    if report.inputQuality.status == "insufficient":
        return MentorResponse(
            summary=say("mentor.insufficientSummary"),
            evidence=[], hypotheses=[], plan=[],
            encouragement=say("mentor.insufficientEncouragement"),
        )
    errors = sorted(report.errors,
                    key=lambda e: (_sev_rank(e.severity.value), -e.confidence))

    if not errors:
        return MentorResponse(
            summary=say("mentor.cleanSummary", overall=m.overallScore, pitch=m.pitchScore,
                        rhythm=m.rhythmScore, fluency=m.fluencyScore),
            evidence=[], hypotheses=[], plan=[],
            encouragement=say("mentor.cleanEncouragement"))

    top = errors[0]
    if selected_error_id:
        sel = [e for e in errors if e.id == selected_error_id]
        if sel:
            top = sel[0]

    type_counts: dict[str, int] = {}
    for e in errors:
        type_counts[e.type.value] = type_counts.get(e.type.value, 0) + 1
    dist = say("mentor.listSeparator").join(
        say("mentor.typeCount", type=_type_label(ErrorType(t)), count=c)
        for t, c in sorted(type_counts.items(), key=lambda kv: -kv[1]))
    summary = say("mentor.summary", overall=m.overallScore, pitch=m.pitchScore,
                  rhythm=m.rhythmScore, fluency=m.fluencyScore,
                  dynamics=m.dynamicsScore, count=len(errors), distribution=dist,
                  bar=top.location["measure"], type=_type_label(top.type))

    ev_map = {ev.id: ev for ev in report.evidences}
    evidence_out = []
    for eid in top.evidenceIds[:3]:
        ev = ev_map.get(eid)
        if ev:
            evidence_out.append({"measure": ev.measureNo, "beat": ev.beat,
                                 "fact": ev.fact})

    hyp_out = [{"cause": h["cause"], "confidence": h["confidence"],
                "limitation": h["limitation"]}
               for h in report.hypotheses[:3]]

    strategy, label_key = STRATEGY_BY_TYPE.get(top.type, ("loop", "strategy.loop"))
    measures = sorted({e.location["measure"] for e in errors
                       if e.type == top.type})[:2]
    plan = [{
        "exerciseType": strategy,
        "measures": measures,
        "tempo": None if strategy == "loop" else 60,
        "repetitions": 4,
        "successCriterion": say("exercise.criterion"),
        "label": say("mentor.planLabel", strategy=say(label_key),
                     start=measures[0], end=measures[-1]),
    }]

    return MentorResponse(
        summary=summary, evidence=evidence_out, hypotheses=hyp_out,
        plan=plan, encouragement=say("mentor.encouragement"))


def answer_question(report: DiagnosisReport, question: str,
                    selected_error_id: str | None = None) -> MentorResponse:
    """追问：基于本次证据回答，不臆测。"""
    base = build_response(report, selected_error_id)
    q = question.strip()
    if not q:
        return base
    m = report.metrics
    if _mentions(q, WHY_WORDS):
        if base.hypotheses:
            h = base.hypotheses[0]
            base.summary = say(
                "mentor.why",
                fact=base.evidence[0].fact if base.evidence else say("mentor.seeReport"),
                cause=h.cause, confidence=h.confidence, limitation=h.limitation)
        else:
            base.summary = say("mentor.whyNoEvidence")
    elif _mentions(q, PRACTICE_WORDS + ("练习", "exercise")):  # i18n: deliberate
        if base.plan:
            p = base.plan[0]
            base.summary = say(
                "mentor.howToPractise", label=p.label,
                start=say("mentor.startTempo", bpm=p.tempo) if p.tempo else "",
                repetitions=p.repetitions, criterion=p.successCriterion,
                mae=m.timingMaeMs)
    elif _mentions(q, SCORE_WORDS):
        base.summary = say("mentor.scores", overall=m.overallScore, pitch=m.pitchScore,
                           rhythm=m.rhythmScore, fluency=m.fluencyScore,
                           bpm=m.avgBpm, mae=m.timingMaeMs)
    return base


def build_chat_response(report: DiagnosisReport, message: str,
                        selected_error_id: str | None = None) -> MentorChatResponse:
    """Deterministic, intent-aware fallback used when the provider is unavailable."""
    q = message.strip()
    base = build_response(report, selected_error_id)
    evidence_ids: list[str] = []
    selected = next((item for item in report.errors if item.id == selected_error_id), None)
    top = selected or (report.errors[0] if report.errors else None)
    if top:
        evidence_ids = top.evidenceIds[:3]

    if _mentions(q, THEORY_WORDS):
        return MentorChatResponse(
            answer=say("chat.theory"),
            intent="theory", evidenceIds=[], professionalGuidance=[], actions=[],
            uncertainty=say("chat.theoryUncertainty"),
            followUpQuestion=say("chat.theoryFollowUp"),
        )
    if _mentions(q, TECHNIQUE_WORDS):
        return MentorChatResponse(
            answer=say("chat.technique"),
            intent="technique", evidenceIds=[],
            professionalGuidance=[say("chat.techniqueSlow"), say("chat.techniqueGeneral")],
            actions=[], uncertainty=say("chat.techniqueUncertainty"),
        )
    if _mentions(q, PRACTICE_WORDS):
        action = ({"type": "generate_exercise", "label": say("chat.actionGenerate"),
                   "errorId": top.id} if top else
                  {"type": "retry", "label": say("chat.actionRetry"), "errorId": None})
        return MentorChatResponse(
            answer=(base.summary if not base.plan else say(
                "chat.plan", label=base.plan[0].label,
                repetitions=base.plan[0].repetitions,
                criterion=base.plan[0].successCriterion)),
            intent="practice_plan", evidenceIds=evidence_ids,
            professionalGuidance=[item.label for item in base.plan],
            actions=[action], uncertainty=say("chat.planUncertainty"),
        )
    if _mentions(q, WHY_WORDS + SCORE_WORDS):
        answered = answer_question(report, q, selected_error_id)
        return MentorChatResponse(
            answer=answered.summary, intent="diagnosis", evidenceIds=evidence_ids,
            professionalGuidance=[], actions=[],
            uncertainty=(answered.hypotheses[0].limitation
                         if answered.hypotheses else say("chat.evidenceOnly")),
        )
    return MentorChatResponse(
        answer=say("chat.clarify"),
        intent="clarification", evidenceIds=[], professionalGuidance=[], actions=[],
        uncertainty=say("chat.localOnly"),
        followUpQuestion=say("chat.clarifyFollowUp"),
    )
