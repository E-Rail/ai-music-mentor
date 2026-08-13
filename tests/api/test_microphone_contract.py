from __future__ import annotations

import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.main import app  # noqa: E402
from app.services.midi_io import load_midi_events  # noqa: E402

FIXTURES = ROOT / "packages" / "score-fixtures"


def test_microphone_events_and_capture_quality_use_existing_analysis_pipeline():
    events = [
        {
            **event.model_dump(), "source": "microphone",
            "transcriptionConfidence": .9, "pitchBendCents": 0,
        }
        for event in load_midi_events(
            str(FIXTURES / "midi" / "melody__standard.mid"))
    ]
    capture_meta = {
        "transcriptionEngine": "spotify-basic-pitch-ts",
        "transcriptionVersion": "1.0.1",
        "thresholdProfile": "audio-piano-v2",
        "audioDurationSeconds": 12.5,
        "inferenceLatencyMs": 900,
        "acceptedNoteCount": len(events), "rejectedNoteCount": 1,
        "noiseFloorDb": -48, "meanConfidence": .9,
        "inputGainDb": 14.5, "rawPeakDb": -35,
        "normalizedPeakDb": -20.5, "signalToNoiseDb": 18,
        "lowVolumeRecovered": True,
    }
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={
            "scoreId": "melody", "rangeStart": 1, "rangeEnd": 8,
            "device": "mock-mic", "inputSource": "microphone",
            "instrument": "piano",
        })
        assert created.status_code == 201, created.text
        finished = client.post(
            f"/api/v1/sessions/{created.json()['sessionId']}/finish",
            json={"events": events, "captureMeta": capture_meta},
        )
        assert finished.status_code == 202, finished.text
        for _ in range(120):
            job = client.get(
                f"/api/v1/analysis/{finished.json()['analysisJobId']}").json()
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(.025)
        assert job["status"] == "completed", job
        report = client.get(f"/api/v1/reports/{job['reportId']}").json()
        assert report["thresholdProfile"] == "audio-piano-v2"
        assert report["inputQuality"]["source"] == "microphone"
        assert report["inputQuality"]["instrument"] == "piano"
        assert report["inputQuality"]["transcriptionVersion"] == "1.0.1"
        assert any("低" in warning and "14.5 dB" in warning
                   for warning in report["warnings"])


def test_quiet_microphone_take_completes_with_limited_evidence_report():
    capture_meta = {
        "transcriptionEngine": "spotify-basic-pitch-ts",
        "transcriptionVersion": "1.0.1",
        "thresholdProfile": "audio-piano-v2",
        "audioDurationSeconds": 4.2,
        "inferenceLatencyMs": 500,
        "acceptedNoteCount": 0,
        "rejectedNoteCount": 2,
        "noiseFloorDb": -31,
        "meanConfidence": 0.12,
    }
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={
            "scoreId": "melody", "rangeStart": 1, "rangeEnd": 8,
            "device": "quiet-mic", "inputSource": "microphone",
            "instrument": "piano",
        })
        assert created.status_code == 201, created.text
        finished = client.post(
            f"/api/v1/sessions/{created.json()['sessionId']}/finish",
            json={"events": [], "captureMeta": capture_meta},
        )
        assert finished.status_code == 202, finished.text
        for _ in range(120):
            job = client.get(
                f"/api/v1/analysis/{finished.json()['analysisJobId']}").json()
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(.025)
        assert job["status"] == "completed", job
        report = client.get(f"/api/v1/reports/{job['reportId']}").json()
        assert report["inputQuality"]["status"] == "insufficient"
        assert report["inputQuality"]["acceptedNoteCount"] == 0
        assert report["metrics"]["overallScore"] == 0
        assert report["errors"] == []
        assert any("录音已接收" in warning for warning in report["warnings"])
