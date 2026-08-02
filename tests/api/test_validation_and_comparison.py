"""API 边界与前后对比的回归测试。"""
from __future__ import annotations

import sys
from math import inf
from pathlib import Path

import mido
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app import storage  # noqa: E402
from app.routes.api import (_uploaded_midi_path, _validated_range,  # noqa: E402
                            compare_sessions, finish_session)
from app.schemas.models import (AccompanimentCreate, PerformanceEvent,  # noqa: E402
                                SessionCreate, SessionFinish)
from app.services.comparison import (compare_reports,  # noqa: E402
                                     error_comparison_key)
from app.services.midi_io import (MidiFileValidationError,  # noqa: E402
                                  load_midi_events, validate_midi_bytes)

FIXTURES = ROOT / "packages" / "score-fixtures" / "midi"


def _metrics(**overrides):
    values = {
        "pitchScore": 70.0,
        "rhythmScore": 75.0,
        "fluencyScore": 80.0,
        "overallScore": 75.0,
        "timingMaeMs": 160.0,
        "avgBpm": 90.0,
    }
    values.update(overrides)
    return values


def _error(event_id: str, detail: str):
    return {
        "type": "wrong_pitch",
        "location": {
            "measure": 3,
            "beat": 1.0,
            "eventId": event_id,
            "eventIds": [event_id],
        },
        "detail": detail,
    }


def test_comparison_keeps_same_measure_errors_separate():
    first = _error("melody:RH:3:1:1", "C4 → C#4")
    second = _error("melody:RH:3:2:1", "D4 → D#4")
    baseline = {"metrics": _metrics(), "errors": [first, second]}
    retry = {
        "metrics": _metrics(pitchScore=90, rhythmScore=85, overallScore=88,
                            timingMaeMs=110),
        "errors": [second],
    }

    result = compare_reports(baseline, retry)

    assert result["resolvedErrors"] == [error_comparison_key(first)]
    assert result["persistentErrors"] == [error_comparison_key(second)]
    assert not result["newErrors"]
    assert result["metricDelta"]["timingMaeMs"] == -50.0


def test_performance_event_rejects_corrupt_note_data():
    with pytest.raises(ValidationError):
        PerformanceEvent(id="bad", tOnMs=100, tOffMs=90, pitch=60)
    with pytest.raises(ValidationError):
        PerformanceEvent(id="bad", tOnMs=0, tOffMs=10, pitch=128)
    with pytest.raises(ValidationError):
        PerformanceEvent(id="bad", tOnMs=inf, tOffMs=inf, pitch=60)

    valid = PerformanceEvent(
        id="pe_1", tOnMs=10, tOffMs=20, pitch=60,
        velocity=127, channel=15, receivedTimeMs=9.5,
    )
    assert valid.receivedTimeMs == 9.5


def test_range_order_is_validated_before_route_logic():
    with pytest.raises(ValidationError):
        SessionCreate(scoreId="melody", rangeStart=5, rangeEnd=4)
    with pytest.raises(ValidationError):
        AccompanimentCreate(scoreId="melody", rangeStart=5, rangeEnd=4)

    class _Meta:
        measureCount = 8

    class _Bundle:
        meta = _Meta()

    with pytest.raises(HTTPException) as exc:
        _validated_range(_Bundle(), 1, 9)  # type: ignore[arg-type]
    assert exc.value.detail["code"] == "RANGE_INVALID"


@pytest.mark.parametrize("reference", [
    "../sess_demo_stolen.mid",
    "other_session_file.mid",
    "/tmp/sess_demo_file.mid",
])
def test_uploaded_midi_reference_must_belong_to_session(reference: str):
    with pytest.raises(HTTPException) as exc:
        _uploaded_midi_path("sess_demo", reference)
    assert exc.value.detail["code"] == "MIDI_FILE_INVALID"


def test_midi_upload_is_parsed_before_it_is_accepted():
    validate_midi_bytes((FIXTURES / "melody__standard.mid").read_bytes())
    with pytest.raises(MidiFileValidationError):
        validate_midi_bytes(b"not-a-midi-file")


def test_multitrack_midi_uses_conductor_tempo(tmp_path):
    midi = mido.MidiFile(ticks_per_beat=480)
    conductor = mido.MidiTrack()
    notes = mido.MidiTrack()
    midi.tracks.extend([conductor, notes])
    conductor.append(mido.MetaMessage("set_tempo", tempo=1_000_000, time=0))  # 60 BPM
    notes.append(mido.Message("note_on", note=60, velocity=80, time=0))
    notes.append(mido.Message("note_off", note=60, velocity=0, time=480))
    path = tmp_path / "multitrack.mid"
    midi.save(path)

    parsed = load_midi_events(str(path))

    assert len(parsed) == 1
    assert parsed[0].tOffMs - parsed[0].tOnMs == pytest.approx(1000.0)


def test_finish_is_idempotent_for_analyzed_session(monkeypatch):
    session = {
        "id": "sess_done", "status": "analyzed",
        "reportId": "rep_done", "jobId": "job_done",
    }
    monkeypatch.setattr(
        storage, "get",
        lambda kind, entity_id: session if (kind, entity_id) == ("session", "sess_done") else None,
    )

    result = finish_session("sess_done", SessionFinish(events=[]))

    assert result == {"analysisJobId": "job_done", "reportId": "rep_done"}


def test_comparison_rejects_different_scores(monkeypatch):
    reports = {
        "rep_a": {"scoreId": "melody"},
        "rep_b": {"scoreId": "chords"},
    }
    monkeypatch.setattr(storage, "get", lambda kind, entity_id: reports.get(entity_id))

    with pytest.raises(HTTPException) as exc:
        compare_sessions("rep_a", "rep_b")
    assert exc.value.detail["code"] == "COMPARISON_MISMATCH"
