from __future__ import annotations

import sys
import time
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.db import repositories  # noqa: E402
from app.db.session import initialize_database  # noqa: E402
from app.main import app  # noqa: E402
from app.schemas.models import MentorChatResponse  # noqa: E402
from app.services.mentor import adapter as mentor_adapter  # noqa: E402


def test_mentor_memory_is_bounded_persistent_and_clearable():
    initialize_database()
    scope = f"test:{uuid.uuid4().hex}"
    try:
        first = repositories.append_mentor_memory(
            scope, "rep_test", "我想一直先慢练", "好的，我会记住。", "practice_plan")
        assert first["rememberedTurnCount"] == 2
        loaded = repositories.get_mentor_memory(scope)
        assert [turn["role"] for turn in loaded["turns"]] == ["user", "assistant"]
        assert "先慢练" in loaded["turns"][0]["content"]

        for index in range(15):
            repositories.append_mentor_memory(
                scope, "rep_test", f"偏好 {index}", f"记住 {index}", "practice_plan")
        bounded = repositories.get_mentor_memory(scope)
        assert bounded["rememberedTurnCount"] <= 20
    finally:
        repositories.clear_mentor_memory(scope)
    assert repositories.get_mentor_memory(scope)["rememberedTurnCount"] == 0


def test_mentor_chat_automatically_reuses_persisted_memory(monkeypatch):
    seen_history: list[list[tuple[str, str]]] = []

    def fake_chat(_report, message, _error_id, history, _context):
        seen_history.append([(turn.role, turn.content) for turn in history])
        return mentor_adapter.MentorChatOutcome(
            MentorChatResponse(
                answer=f"记住：{message}", intent="practice_plan",
                evidenceIds=[], professionalGuidance=[], actions=[], uncertainty="",
            ),
            "fake", "fake-model", "json_schema", 1,
        )

    monkeypatch.setattr(mentor_adapter, "chat", fake_chat)
    capture_meta = {
        "transcriptionEngine": "test", "transcriptionVersion": "1",
        "thresholdProfile": "audio-piano-v2", "audioDurationSeconds": 1,
        "inferenceLatencyMs": 1, "acceptedNoteCount": 0,
        "rejectedNoteCount": 0, "noiseFloorDb": -40, "meanConfidence": 0,
    }
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={
            "scoreId": "melody", "rangeStart": 1, "rangeEnd": 8,
            "device": "memory-test-mic", "inputSource": "microphone",
            "instrument": "piano",
        }).json()
        finished = client.post(
            f"/api/v1/sessions/{created['sessionId']}/finish",
            json={"events": [], "captureMeta": capture_meta},
        ).json()
        for _ in range(120):
            job = client.get(f"/api/v1/analysis/{finished['analysisJobId']}").json()
            if job["status"] == "completed":
                break
            time.sleep(.025)
        report_id = job["reportId"]
        first = client.post("/api/v1/mentor/chat", json={
            "reportId": report_id, "message": "以后都先慢练", "history": [],
        })
        assert first.status_code == 200, first.text
        second = client.post("/api/v1/mentor/chat", json={
            "reportId": report_id, "message": "你还记得吗？", "history": [],
        })
        assert second.status_code == 200, second.text
        assert seen_history[0] == []
        assert seen_history[1] == [
            ("user", "以后都先慢练"), ("assistant", "记住：以后都先慢练"),
        ]
        status = client.get(f"/api/v1/mentor/memory?reportId={report_id}").json()
        assert status["rememberedTurnCount"] == 4
        assert client.delete(f"/api/v1/mentor/memory?reportId={report_id}").status_code == 204
