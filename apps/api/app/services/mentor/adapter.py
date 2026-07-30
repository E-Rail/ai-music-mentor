"""LLM Adapter（方案 5.10）：可替换模型适配层。

- MENTOR_PROVIDER=rules → 本地规则模板（默认，答辩主链路）
- MENTOR_PROVIDER=llm   → OpenAI 兼容接口 + JSON Schema 约束输出；
  Pydantic 校验失败重试一次，仍失败回落本地模板（MENTOR_UNAVAILABLE）

API Key 只在服务器端；设置超时、预算与日志脱敏。
"""
from __future__ import annotations

import json

from app import config
from app.schemas.models import DiagnosisReport, MentorResponse
from app.services.mentor import templates

PROMPT_VERSION = "mentor-v1"

SYSTEM_PROMPT = """你是钢琴练习导师。你只能基于给定的结构化诊断 JSON 回答。
规则：
1. 不得修改 errorType、位置和数值；建议必须引用 evidence 中的事实。
2. 没有视频证据时，不得断言手型、指法或动作问题；只能用"可能/疑似"。
3. 输出必须是符合给定 JSON Schema 的 JSON，不要输出其他内容。"""

MENTOR_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "evidence": {"type": "array", "items": {"type": "object",
                     "properties": {"measure": {"type": "number"},
                                    "beat": {"type": "number"},
                                    "fact": {"type": "string"}},
                     "required": ["measure", "beat", "fact"]}},
        "hypotheses": {"type": "array", "items": {"type": "object",
                       "properties": {"cause": {"type": "string"},
                                      "confidence": {"type": "number"},
                                      "limitation": {"type": "string"}},
                       "required": ["cause", "confidence", "limitation"]}},
        "plan": {"type": "array", "items": {"type": "object"}},
        "encouragement": {"type": "string"},
    },
    "required": ["summary", "evidence", "hypotheses", "plan", "encouragement"],
}


def _diagnosis_payload(report: DiagnosisReport) -> dict:
    """脱敏后的结构化诊断摘要（不含原始乐谱/音频）。"""
    return {
        "scoreId": report.scoreId,
        "metrics": report.metrics.model_dump(),
        "errors": [{"type": e.type.value, "location": e.location,
                    "severity": e.severity.value, "confidence": e.confidence}
                   for e in report.errors[:10]],
        "evidences": [{"measure": ev.measureNo, "beat": ev.beat,
                       "fact": ev.fact} for ev in report.evidences[:10]],
        "hypotheses": report.hypotheses[:5],
    }


class MentorUnavailableError(Exception):
    pass


def respond(report: DiagnosisReport, question: str = "",
            selected_error_id: str | None = None) -> tuple[MentorResponse, str]:
    """返回 (MentorResponse, provider)。LLM 失败自动回落模板。"""
    if config.MENTOR_PROVIDER != "llm" or not config.MENTOR_API_KEY:
        if question:
            return templates.answer_question(report, question,
                                             selected_error_id), "rules"
        return templates.build_response(report, selected_error_id), "rules"
    try:
        return _llm_respond(report, question), "llm"
    except Exception:  # noqa: BLE001 —— 重试一次
        try:
            return _llm_respond(report, question), "llm-retry"
        except Exception as e:  # noqa: BLE001
            resp = (templates.answer_question(report, question,
                                              selected_error_id)
                    if question else
                    templates.build_response(report, selected_error_id))
            return resp, f"rules-fallback({type(e).__name__})"


def _llm_respond(report: DiagnosisReport, question: str) -> MentorResponse:
    import httpx

    payload = _diagnosis_payload(report)
    user = json.dumps({"diagnosis": payload, "question": question},
                      ensure_ascii=False)
    with httpx.Client(timeout=config.MENTOR_TIMEOUT_SECONDS) as client:
        r = client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {config.MENTOR_API_KEY}"},
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                             {"role": "user", "content": user}],
                "response_format": {"type": "json_object"},
                "temperature": 0.3,
            })
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
    data = json.loads(content)
    return MentorResponse.model_validate(data)   # Pydantic 校验，失败抛异常触发重试
