"""Fake OpenAI-compatible transports for structured modes and fallback behavior."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app import config  # noqa: E402
from app.schemas.models import (DiagnosisReport, ExerciseParams, MentorChatTurn,
                                Metrics)  # noqa: E402
from app.services.mentor import adapter  # noqa: E402


def _report() -> DiagnosisReport:
    return DiagnosisReport(
        reportId="rep_fake", sessionId="sess_fake", scoreId="score_fake",
        metrics=Metrics(overallScore=88, pitchScore=90, rhythmScore=84,
                        fluencyScore=87, timingMaeMs=108),
        algorithmVersion="test", thresholdProfile="test", scoreHash="abc123",
    )


def _error_report() -> DiagnosisReport:
    data = _report().model_dump(mode="json")
    data.update({
        "errors": [{
            "id": "err_timing", "type": "early_late",
            "location": {"measure": 2, "beat": 1, "eventId": "event_2"},
            "severity": "medium", "evidenceIds": ["ev_timing"],
            "confidence": 0.84, "detail": "延后 165 ms",
        }],
        "evidences": [{
            "id": "ev_timing", "fact": "第 2 小节第 2 拍延后 165 ms",
            "measureNo": 2, "beat": 1, "expected": "C4", "actual": "C4",
            "deltaMs": 165,
        }],
    })
    return DiagnosisReport.model_validate(data)


def _valid_content() -> str:
    return json.dumps({
        "summary": "节奏证据稳定。", "evidence": [], "hypotheses": [], "plan": [],
        "encouragement": "继续保持。",
    }, ensure_ascii=False)


def _patch_client(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    original = httpx.Client

    def factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(adapter.httpx, "Client", factory)


def _configure(monkeypatch, mode: str):
    monkeypatch.setattr(config, "MENTOR_API_BASE", "https://fake-provider.test/v1")
    monkeypatch.setattr(config, "MENTOR_API_KEY", "secret-never-logged")
    monkeypatch.setattr(config, "MENTOR_MODEL", "fake-model")
    monkeypatch.setattr(config, "MENTOR_RESPONSE_MODE", mode)
    monkeypatch.setattr(config, "MENTOR_REASONING_EFFORT", "low")


def test_json_schema_mode_sends_schema_and_validates(monkeypatch):
    captured = {}

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": _valid_content()}}],
        })

    _configure(monkeypatch, "json_schema")
    _patch_client(monkeypatch, handler)
    outcome = adapter.respond(_report())
    assert outcome.provider == "fake-provider.test"
    assert outcome.response.summary
    assert captured["response_format"]["type"] == "json_schema"
    assert captured["response_format"]["json_schema"]["strict"] is True
    schema = captured["response_format"]["json_schema"]["schema"]
    assert set(schema["required"]) == set(schema["properties"])
    plan_schema = schema["$defs"]["MentorPlanItem"]
    assert set(plan_schema["required"]) == set(plan_schema["properties"])


def test_openrouter_requires_parameter_capable_routes(monkeypatch):
    captured = {}

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": _valid_content()}}],
        })

    _configure(monkeypatch, "json_schema")
    monkeypatch.setattr(config, "MENTOR_API_BASE", "https://openrouter.ai/api/v1")
    _patch_client(monkeypatch, handler)

    outcome = adapter.respond(_report())

    assert outcome.provider == "openrouter.ai"
    assert captured["provider"] == {"require_parameters": True}
    assert captured["reasoning"] == {"effort": "low", "exclude": True}


def test_json_object_mode_and_malformed_retry_fall_back(monkeypatch):
    calls = 0

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "not-json"}}],
        })

    _configure(monkeypatch, "json_object")
    _patch_client(monkeypatch, handler)
    outcome = adapter.respond(_report(), "怎么练？")
    assert calls == 2
    assert outcome.provider == "rules-fallback"
    assert outcome.fallback_reason == "JSONDecodeError"
    assert outcome.response.summary


def test_timeout_falls_back_without_losing_report(monkeypatch):
    calls = 0

    def handler(request: httpx.Request):
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("simulated timeout", request=request)

    _configure(monkeypatch, "prompt_json")
    _patch_client(monkeypatch, handler)
    outcome = adapter.respond(_report())
    assert calls == 1
    assert outcome.provider == "rules-fallback"
    assert outcome.fallback_reason == "ReadTimeout"


def test_empty_provider_content_retries_then_falls_back(monkeypatch):
    calls = 0

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={
            "choices": [{"message": {"content": None}}],
        })

    _configure(monkeypatch, "json_schema")
    _patch_client(monkeypatch, handler)
    outcome = adapter.respond(_report())

    assert calls == 2
    assert outcome.provider == "rules-fallback"
    assert outcome.fallback_reason == "ValueError"
    assert outcome.response.summary


def test_model_cannot_invent_evidence(monkeypatch):
    calls = 0
    content = json.dumps({
        "summary": "虚构证据。",
        "evidence": [{"measure": 99, "beat": 0, "fact": "不存在的事实"}],
        "hypotheses": [], "plan": [], "encouragement": "继续。",
    }, ensure_ascii=False)

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={
            "choices": [{"message": {"content": content}}],
        })

    _configure(monkeypatch, "json_schema")
    _patch_client(monkeypatch, handler)
    outcome = adapter.respond(_report())

    assert calls == 2
    assert outcome.provider == "rules-fallback"
    assert outcome.fallback_reason == "ValueError"


def test_chat_history_is_bounded_and_sent_in_order(monkeypatch):
    captured = {}

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": _valid_content()}}],
        })

    _configure(monkeypatch, "json_schema")
    _patch_client(monkeypatch, handler)
    history = [
        MentorChatTurn(role="user", content="上一问"),
        MentorChatTurn(role="assistant", content="上一答"),
    ]
    outcome = adapter.respond(_report(), "继续怎么练？", history=history)

    assert outcome.provider == "fake-provider.test"
    messages = captured["messages"]
    assert [message["role"] for message in messages] == [
        "system", "user", "assistant", "user",
    ]
    assert messages[-1]["content"] == "继续怎么练？"


def test_ai_exercise_planner_returns_grounded_parameters(monkeypatch):
    captured = {}
    content = json.dumps({
        "title": "节奏稳定微练习", "strategy": "slow_ladder",
        "errorIds": ["err_timing"], "tempoRatio": 0.5, "loopCount": 3,
        "hands": None, "rationale": "先降低速度稳定拍点。",
        "noteAcknowledgement": "已采用五分钟限制。",
    }, ensure_ascii=False)

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": content}}],
        })

    _configure(monkeypatch, "json_schema")
    _patch_client(monkeypatch, handler)
    outcome = adapter.plan_exercise(
        _error_report(), "控制在五分钟", ["err_timing"],
        ExerciseParams(strategy="auto", errorIds=["err_timing"]),
    )

    assert outcome.provider == "fake-provider.test"
    assert outcome.response.errorIds == ["err_timing"]
    assert outcome.response.strategy == "slow_ladder"
    assert captured["response_format"]["json_schema"]["name"] == "exercise_planner_response"
    assert "控制在五分钟" in captured["messages"][-1]["content"]
