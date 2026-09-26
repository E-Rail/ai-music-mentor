"""The server answers in the language the request asks for.

The browser sends Accept-Language with the player's chosen language on every
call. These tests go through the real routes: one take, analysed once, read
back in both languages; an error; the library; and the mentor.
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app import config  # noqa: E402
from app.main import app  # noqa: E402
from app.services.mentor import adapter as mentor_adapter  # noqa: E402

FIXTURES = ROOT / "packages" / "score-fixtures"
CJK = re.compile(r"[　-〿㐀-鿿＀-￯]")
EN = {"Accept-Language": "en-US"}
ZH = {"Accept-Language": "zh-CN"}


def _texts(report: dict) -> list[str]:
    """Every sentence in a report a player reads."""
    return [
        *(item[field] for item in report["evidences"]
          for field in ("fact", "expected", "actual") if item[field]),
        *(error["detail"] for error in report["errors"] if error["detail"]),
        *(pattern["description"] for pattern in report["patterns"]),
        *(item[field] for item in report["hypotheses"] for field in ("cause", "limitation")),
        *report["warnings"], *report["notes"],
    ]


def _analysed_take(client: TestClient) -> str:
    session = client.post("/api/v1/sessions", json={
        "scoreId": "melody", "rangeStart": 1, "rangeEnd": 8, "device": "midi-file",
    }).json()["sessionId"]
    uploaded = client.post(f"/api/v1/sessions/{session}/upload-midi", files={"file": (
        "take.mid", (FIXTURES / "midi" / "melody__wrong_pitch.mid").read_bytes(), "audio/midi",
    )}).json()
    finished = client.post(f"/api/v1/sessions/{session}/finish", json={
        "events": [], "uploadedMidiRef": uploaded["uploadedMidiRef"],
    }).json()
    if finished.get("reportId"):
        return finished["reportId"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = client.get(f"/api/v1/analysis/{finished['analysisJobId']}").json()
        if job["status"] == "completed":
            return job["reportId"]
        assert job["status"] != "failed", job
        time.sleep(0.05)
    raise AssertionError("analysis did not finish")


def test_one_stored_report_reads_in_either_language():
    with TestClient(app) as client:
        report_id = _analysed_take(client)
        chinese = client.get(f"/api/v1/reports/{report_id}", headers=ZH).json()
        english = client.get(f"/api/v1/reports/{report_id}", headers=EN).json()
        default = client.get(f"/api/v1/reports/{report_id}").json()

    assert any(error["type"] == "wrong_pitch" for error in english["errors"])
    zh_texts, en_texts = _texts(chinese), _texts(english)
    assert zh_texts and len(zh_texts) == len(en_texts)
    assert all(CJK.search(text) or not re.search("[A-Za-z]{3}", text) for text in zh_texts
               if not re.fullmatch(r"[A-G][#b]?\d(/[A-G][#b]?\d)*", text))
    assert [text for text in en_texts if CJK.search(text)] == []
    # Only the words changed: the findings themselves are the same findings.
    assert [e["id"] for e in english["errors"]] == [e["id"] for e in chinese["errors"]]
    assert english["metrics"] == chinese["metrics"]
    # A client that names no language gets what every client got before.
    assert _texts(default) == zh_texts


def test_evidence_carries_the_notes_to_play_back():
    with TestClient(app) as client:
        report = client.get(f"/api/v1/reports/{_analysed_take(client)}", headers=EN).json()
    wrong = next(item for item in report["evidences"] if item["expectedPitches"]
                 and item["actualPitches"])
    assert all(isinstance(pitch, int) for pitch in wrong["expectedPitches"])
    assert wrong["expectedPitches"] != wrong["actualPitches"]


def test_errors_are_said_in_the_requested_language():
    with TestClient(app) as client:
        english = client.get("/api/v1/reports/rep_missing", headers=EN).json()
        chinese = client.get("/api/v1/reports/rep_missing", headers=ZH).json()
    assert english["detail"]["code"] == chinese["detail"]["code"] == "REPORT_NOT_FOUND"
    assert english["detail"]["message"] == "There is no report rep_missing"
    assert chinese["detail"]["message"] == "报告 rep_missing 不存在"


def test_a_bundled_piece_goes_by_its_name_in_the_readers_language():
    with TestClient(app) as client:
        english = {score["scoreId"]: score["title"] for score in
                   client.get("/api/v1/scores", headers=EN).json()["scores"]}
        chinese = {score["scoreId"]: score["title"] for score in
                   client.get("/api/v1/scores", headers=ZH).json()["scores"]}
        detail = client.get("/api/v1/scores/twinkle_star", headers=EN).json()
    assert english["twinkle_star"] == "Twinkle, Twinkle, Little Star"
    assert chinese["twinkle_star"] == "小星星"
    assert detail["metadata"]["title"] == "Twinkle, Twinkle, Little Star"


def test_the_offline_mentor_answers_in_the_players_language(monkeypatch):
    monkeypatch.setattr(config, "MENTOR_API_BASE", "")
    with TestClient(app) as client:
        report_id = _analysed_take(client)
        summary = client.post("/api/v1/mentor/responses", headers=EN,
                              json={"reportId": report_id}).json()
        chat = client.post("/api/v1/mentor/chat", headers=EN, json={
            "reportId": report_id, "message": "How should I practise this?",
        }).json()
        # Chat is remembered per piece; leave the next test a clean slate.
        client.delete(f"/api/v1/mentor/memory?reportId={report_id}")
    assert summary["provider"] == "rules"
    for text in (summary["summary"], summary["encouragement"],
                 *(item["label"] for item in summary["plan"]),
                 chat["answer"], chat["uncertainty"],
                 *(action["label"] for action in chat["actions"])):
        assert not CJK.search(text), text
    assert chat["intent"] == "practice_plan"


def test_the_ai_is_told_which_language_to_reply_in(monkeypatch):
    seen: list[list[dict]] = []

    def fake_request(messages, schema, name):
        seen.append(messages)
        # A failure the adapter already handles, so the request falls back
        # to the rules mentor instead of erroring.
        raise ValueError("stop after capturing the prompt")

    monkeypatch.setattr(config, "MENTOR_API_BASE", "https://example.invalid/v1")
    monkeypatch.setattr(config, "MENTOR_API_KEY", "test")
    monkeypatch.setattr(config, "MENTOR_MODEL", "test-model")
    monkeypatch.setattr(mentor_adapter, "_request_structured", fake_request)
    with TestClient(app) as client:
        report_id = _analysed_take(client)
        reply = client.post("/api/v1/mentor/chat", headers=EN, json={
            "reportId": report_id, "message": "Why was bar 2 wrong?"}).json()
        client.delete(f"/api/v1/mentor/memory?reportId={report_id}")
    assert seen, "the remote mentor was never asked"
    # ...and when it fails, the fallback still answers in English.
    assert not CJK.search(reply["answer"]), reply["answer"]
    system = seen[0][0]["content"]
    assert '"replyLanguage": "English"' in system
    # The facts it is given are in the language it must answer in.
    assert "Expected" in system and "期望" not in system


def test_a_failed_analysis_is_explained_in_the_language_of_whoever_reads_it():
    """Analysis runs on a worker thread with no reader, so its failure is stored
    as a message and said when polled."""
    from app.db import repositories
    from app.i18n import msg

    with TestClient(app) as client:
        session = client.post("/api/v1/sessions", json={
            "scoreId": "melody", "rangeStart": 1, "rangeEnd": 2, "device": "midi-file",
        }).json()["sessionId"]
        repositories.save_job("job_language_probe", {
            "sessionId": session, "status": "failed", "progress": 100,
            "errorCode": "ANALYSIS_FAILED",
            "errorMessage": msg("analysis.failed").model_dump_json(),
        })
        english = client.get("/api/v1/analysis/job_language_probe", headers=EN).json()
        chinese = client.get("/api/v1/analysis/job_language_probe", headers=ZH).json()
    assert english["errorMessage"] == (
        "Analysis failed. The recording is kept and can be submitted again")
    assert chinese["errorMessage"] == "分析失败，录音已保留，可重新提交"
