"""AI 导师（方案 5.10）：规则模板实现（MENTOR_PROVIDER=rules 及 LLM 降级兜底）。

输入是诊断摘要（DiagnosisPayload），不接触原始乐谱/音频。
输出固定 MentorResponse Schema；不得修改 errorType、位置和数值；
建议必须引用 evidence；无视频时禁止断言手型/指法。
"""
from __future__ import annotations

from app.schemas.models import DiagnosisReport, ErrorType, MentorResponse

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
    ErrorType.wrong_pitch: ("loop", "片段循环"),
    ErrorType.missed_note: ("loop", "片段循环"),
    ErrorType.extra_note: ("loop", "片段循环"),
    ErrorType.early_late: ("slow_ladder", "慢速阶梯"),
    ErrorType.tempo_instability: ("slow_ladder", "慢速阶梯"),
    ErrorType.duration_anomaly: ("rhythm_variant", "节奏变体"),
}


def _sev_rank(s: str) -> int:
    return {"high": 0, "medium": 1, "low": 2}.get(s, 3)


def build_response(report: DiagnosisReport,
                   selected_error_id: str | None = None) -> MentorResponse:
    m = report.metrics
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
               f"节奏 {m.rhythmScore} / 流畅度 {m.fluencyScore}）。"
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
