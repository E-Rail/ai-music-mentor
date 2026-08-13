"""AI 导师（方案 5.10）：规则模板实现（MENTOR_PROVIDER=rules 及 LLM 降级兜底）。

输入是诊断摘要（DiagnosisPayload），不接触原始乐谱/音频。
输出固定 MentorResponse Schema；不得修改 errorType、位置和数值；
建议必须引用 evidence；无视频时禁止断言手型/指法。
"""
from __future__ import annotations

from app.schemas.models import (DiagnosisReport, ErrorType, MentorChatResponse,
                                MentorResponse)

TYPE_LABEL = {
    ErrorType.wrong_pitch: "错音",
    ErrorType.missed_note: "漏音",
    ErrorType.extra_note: "多音",
    ErrorType.early_late: "节奏提前/延后",
    ErrorType.duration_anomaly: "时值不稳定",
    ErrorType.tempo_instability: "速度不稳",
    ErrorType.dynamics_anomaly: "力度异常",
}

STRATEGY_BY_TYPE = {
    ErrorType.wrong_pitch: ("chunk_connect", "动机连接"),
    ErrorType.missed_note: ("chunk_connect", "动机连接"),
    ErrorType.extra_note: ("chunk_connect", "动机连接"),
    ErrorType.early_late: ("slow_ladder", "慢速阶梯"),
    ErrorType.tempo_instability: ("slow_ladder", "慢速阶梯"),
    ErrorType.duration_anomaly: ("rhythm_variant", "节奏变体"),
    ErrorType.dynamics_anomaly: ("chunk_connect", "力度轮廓与动机连接"),
}


def _sev_rank(s: str) -> int:
    return {"high": 0, "medium": 1, "low": 2}.get(s, 3)


def build_response(report: DiagnosisReport,
                   selected_error_id: str | None = None) -> MentorResponse:
    m = report.metrics
    if report.inputQuality.status == "insufficient":
        return MentorResponse(
            summary=("这次录音已经接收并保存为最终结果，但可用音符或可靠匹配点不足，"
                     "所以本轮不显示演奏分数，也不判断具体错误。"),
            evidence=[], hypotheses=[], plan=[],
            encouragement="录音没有被丢弃。你可以询问录音设置，或调整距离后再录一轮。",
        )
    errors = sorted(report.errors,
                    key=lambda e: (_sev_rank(e.severity.value), -e.confidence))

    if not errors:
        return MentorResponse(
            summary=(f"本次演奏整体 {m.overallScore} 分，音准 {m.pitchScore}、"
                     f"节奏 {m.rhythmScore}、流畅度 {m.fluencyScore}，"
                     f"未发现明确错误，完成度很好。"),
            evidence=[], hypotheses=[], plan=[],
            encouragement="保持这个状态，可以尝试原速完整演奏一遍。")

    top = errors[0]
    if selected_error_id:
        sel = [e for e in errors if e.id == selected_error_id]
        if sel:
            top = sel[0]

    type_counts: dict[str, int] = {}
    for e in errors:
        type_counts[e.type.value] = type_counts.get(e.type.value, 0) + 1
    dist = "、".join(f"{TYPE_LABEL.get(ErrorType(t), t)} {c} 处"
                     for t, c in sorted(type_counts.items(),
                                        key=lambda kv: -kv[1]))
    summary = (f"本次演奏整体 {m.overallScore} 分（音准 {m.pitchScore} / "
               f"节奏 {m.rhythmScore} / 流畅度 {m.fluencyScore} / "
               f"力度 {m.dynamicsScore}）。"
               f"共发现 {len(errors)} 处问题：{dist}。"
               f"建议优先处理第 {top.location['measure']} 小节的"
               f"{TYPE_LABEL.get(top.type, top.type.value)}。")

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

    strategy, label = STRATEGY_BY_TYPE.get(top.type, ("loop", "片段循环"))
    measures = sorted({e.location["measure"] for e in errors
                       if e.type == top.type})[:2]
    plan = [{
        "exerciseType": strategy,
        "measures": measures,
        "tempo": None if strategy == "loop" else 60,
        "repetitions": 4,
        "successCriterion": "连续两次 pitchScore ≥ 95 且 timing MAE ≤ 120 ms",
        "label": f"{label} · 第 {measures[0]}-{measures[-1]} 小节",
    }]

    return MentorResponse(
        summary=summary, evidence=evidence_out, hypotheses=hyp_out,
        plan=plan,
        encouragement="每一次缓慢的准确练习，都在为肌肉记忆投票。加油！")


def answer_question(report: DiagnosisReport, question: str,
                    selected_error_id: str | None = None) -> MentorResponse:
    """追问：基于本次证据回答，不臆测。"""
    base = build_response(report, selected_error_id)
    q = question.strip()
    if not q:
        return base
    m = report.metrics
    if any(k in q for k in ("为什么", "为啥", "原因")):
        if base.hypotheses:
            h = base.hypotheses[0]
            base.summary = (
                f"从本次证据看：{base.evidence[0].fact if base.evidence else '详见报告'}。"
                f"{h.cause}（置信度 {h.confidence}）。"
                f"需要说明：{h.limitation}。")
        else:
            base.summary = "本次演奏没有足够证据指向具体原因，整体完成度较好。"
    elif any(k in q for k in ("怎么练", "如何练", "练习", "提高", "改进")):
        if base.plan:
            p = base.plan[0]
            tempo_txt = f"，从 {p.tempo} BPM 起步" if p.tempo else ""
            base.summary = (
                f"建议做「{p.label}」练习{tempo_txt}，循环 {p.repetitions} 次。"
                f"达标标准：{p.successCriterion}。"
                f"当前 timing MAE 为 {m.timingMaeMs} ms，可以作为对比基线。")
    elif any(k in q for k in ("分数", "多少分", "评价", "怎么样")):
        base.summary = (
            f"整体 {m.overallScore} 分：音准 {m.pitchScore}、节奏 {m.rhythmScore}、"
            f"流畅度 {m.fluencyScore}。平均速度约 {m.avgBpm} BPM，"
            f"timing MAE {m.timingMaeMs} ms。")
    return base


def build_chat_response(report: DiagnosisReport, message: str,
                        selected_error_id: str | None = None) -> MentorChatResponse:
    """Deterministic, intent-aware fallback used when the provider is unavailable."""
    q = message.strip()
    lower = q.lower()
    base = build_response(report, selected_error_id)
    evidence_ids: list[str] = []
    selected = next((item for item in report.errors if item.id == selected_error_id), None)
    top = selected or (report.errors[0] if report.errors else None)
    if top:
        evidence_ids = top.evidenceIds[:3]

    if any(key in lower for key in ("和弦", "音阶", "调式", "theory", "chord", "scale")):
        return MentorChatResponse(
            answer=("这是一个乐理问题，我可以直接讲概念；不过当前 AI 服务不可用，"
                    "本地模式不会猜测你具体想问的和弦或音阶。请补充名称或调性，我会给出针对性的解释。"),
            intent="theory", evidenceIds=[], professionalGuidance=[], actions=[],
            uncertainty="当前为本地降级回答，未调用远程音乐知识模型。",
            followUpQuestion="你想了解哪个和弦、音阶或调性？",
        )
    if any(key in lower for key in (
            "手型", "指法", "姿势", "bow", "fingering", "posture", "technique", "技巧")):
        return MentorChatResponse(
            answer=("我没有视频或动作传感器，不能断言你的手型、姿势或运弓有问题。"
                    "一般可以先做无痛、放松、慢速的自检；若出现疼痛请停止并请老师现场观察。"),
            intent="technique", evidenceIds=[],
            professionalGuidance=["把速度降到能保持放松和均匀发音的水平。",
                                  "把动作建议视为一般自检，而不是本次演奏的已测事实。"],
            actions=[], uncertainty="本次只有声音/MIDI证据，没有身体动作证据。",
        )
    if any(key in lower for key in (
            "怎么练", "如何练", "练习计划", "practice", "提高", "改进", "plan")):
        action = ({"type": "generate_exercise", "label": "生成下一条针对性练习",
                   "errorId": top.id} if top else
                  {"type": "retry", "label": "再演奏一次", "errorId": None})
        return MentorChatResponse(
            answer=(base.summary if not base.plan else
                    f"{base.plan[0].label}：循环 {base.plan[0].repetitions} 次。"
                    f"达标标准是 {base.plan[0].successCriterion}。"),
            intent="practice_plan", evidenceIds=evidence_ids,
            professionalGuidance=[item.label for item in base.plan],
            actions=[action], uncertainty="这是确定性降级方案，可在 AI 恢复后进一步个性化。",
        )
    if any(key in lower for key in ("为什么", "原因", "why", "报告", "分数", "score")):
        answered = answer_question(report, q, selected_error_id)
        return MentorChatResponse(
            answer=answered.summary, intent="diagnosis", evidenceIds=evidence_ids,
            professionalGuidance=[], actions=[],
            uncertainty=(answered.hypotheses[0].limitation
                         if answered.hypotheses else "只依据当前演奏证据。"),
        )
    return MentorChatResponse(
        answer=("我理解你在问音乐学习问题，但当前 AI 服务不可用，本地模式需要更具体的目标"
                "才能避免答非所问。"),
        intent="clarification", evidenceIds=[], professionalGuidance=[], actions=[],
        uncertainty="当前为本地降级回答。",
        followUpQuestion="你想先聊本轮诊断、演奏技巧、乐理，还是下一步练习？",
    )
