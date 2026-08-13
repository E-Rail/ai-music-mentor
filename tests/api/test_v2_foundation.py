"""Production-shaped v2 API contracts: import review, batches, and jobs."""
from __future__ import annotations

import io
import sys
import time
import uuid
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
import mido
import pytest
from starlette.websockets import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.main import app  # noqa: E402
from app import config  # noqa: E402
from app.db import repositories  # noqa: E402
from app.schemas.models import ExercisePlannerResponse  # noqa: E402
from app.schemas.models import PerformanceEvent  # noqa: E402
from app.services.importers.midi import MidiScoreImporter  # noqa: E402
from app.services.mentor import adapter as mentor_adapter  # noqa: E402
from app.services.mentor.adapter import ExercisePlanOutcome  # noqa: E402
from app.services.midi_io import load_midi_events  # noqa: E402
from app.services.score_import import parse_musicxml  # noqa: E402
from app.services.diagnosis.pipeline import run_analysis  # noqa: E402
from app.services.score_ingestion import ingest_score  # noqa: E402

FIXTURES = ROOT / "packages" / "score-fixtures"


def _mxl(xml: bytes, rootfile: str = "score.musicxml", include_traversal: bool = False) -> bytes:
    out = io.BytesIO()
    container = f'''<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="{rootfile}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles>
    </container>'''.encode()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("META-INF/container.xml", container)
        archive.writestr(rootfile, xml)
        if include_traversal:
            archive.writestr("../escape.txt", b"no")
    return out.getvalue()


def test_musicxml_mxl_and_midi_share_normalized_contract():
    xml = (FIXTURES / "scores" / "melody.musicxml").read_bytes()
    midi = (FIXTURES / "midi" / "melody__standard.mid").read_bytes()
    with TestClient(app) as client:
        exact = client.post("/api/v1/scores/import", files={
            "file": ("piece.mxl", _mxl(xml), "application/vnd.recordare.musicxml"),
        })
        assert exact.status_code == 201, exact.text
        assert exact.json()["sourceType"] == "mxl"
        assert exact.json()["displayMode"] == "exact_notation"
        assert exact.json()["libraryCategory"] == "uploaded"
        assert exact.json()["sourceName"] == "piece.mxl"

        simplified = client.post("/api/v1/scores/import", files={
            "file": ("take.mid", midi, "audio/midi"),
        })
        assert simplified.status_code == 201, simplified.text
        body = simplified.json()
        assert body["sourceType"] == "midi"
        assert body["displayMode"] == "simplified_quantized_staff"
        assert body["timelineUrl"].endswith("timeline.midi")
        assert body["normalization"]["tempo"] > 0
        assert body["warnings"]
        assert body["libraryCategory"] == "uploaded"

        confirmed = client.patch(
            f"/api/v1/scores/{body['scoreId']}/normalization",
            json={**body["normalization"], "confirmed": True},
        )
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["normalization"]["confirmed"] is True
        assert client.get(confirmed.json()["renderUrl"]).status_code == 200


def test_score_library_separates_user_demo_generated_and_internal_records():
    xml = (FIXTURES / "scores" / "melody.musicxml").read_bytes()
    internal_id = f"internal_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        ingest_score("internal-fixture.musicxml", xml, score_id=internal_id)
        uploaded = client.post("/api/v1/scores/import", files={
            "file": ("My piece.musicxml", xml, "application/vnd.recordare.musicxml"),
        })
        assert uploaded.status_code == 201, uploaded.text

        scores = client.get("/api/v1/scores").json()["scores"]
        by_id = {score["scoreId"]: score for score in scores}
        assert by_id["melody"]["libraryCategory"] == "demo"
        assert by_id[uploaded.json()["scoreId"]]["libraryCategory"] == "uploaded"
        assert by_id[uploaded.json()["scoreId"]]["sourceName"] == "My piece.musicxml"
        assert internal_id not in by_id


def test_mxl_path_traversal_is_rejected_before_storage():
    xml = (FIXTURES / "scores" / "melody.musicxml").read_bytes()
    with TestClient(app) as client:
        response = client.post("/api/v1/scores/import", files={
            "file": ("unsafe.mxl", _mxl(xml, include_traversal=True), "application/zip"),
        })
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "SCORE_UNSUPPORTED"


def test_clean_two_track_midi_infers_hands_and_defaults_metadata():
    midi = mido.MidiFile(ticks_per_beat=480)
    low, high = mido.MidiTrack(), mido.MidiTrack()
    midi.tracks.extend([low, high])
    low.extend([mido.Message("note_on", note=45, velocity=70, time=0),
                mido.Message("note_off", note=45, velocity=0, time=480)])
    high.extend([mido.Message("note_on", note=72, velocity=80, time=0),
                 mido.Message("note_off", note=72, velocity=0, time=480)])
    raw = io.BytesIO()
    midi.save(file=raw)

    result = MidiScoreImporter().import_bytes("two-track.mid", raw.getvalue(), "two_track")

    assert set(result.normalized.normalization.trackMapping.values()) == {"LH", "RH"}
    assert result.normalized.bundle.meta.tempo == 120
    assert sorted(event.dynamicTarget for event in result.normalized.bundle.events) == [70, 80]
    assert result.normalized.bundle.meta.timeSignature == "4/4"
    assert any("120 BPM" in warning for warning in result.normalized.warnings)


def test_musicxml_half_note_meter_and_expanded_repeats_have_linear_unique_timeline():
    xml = b'''<?xml version="1.0"?>
    <score-partwise version="3.1">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>2</beat-type></time></attributes>
          <barline location="left"><repeat direction="forward"/></barline>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
          <barline location="right"><repeat direction="backward"/></barline>
        </measure>
      </part>
    </score-partwise>'''

    bundle = parse_musicxml(xml, "repeat_half_note")

    assert bundle.meta.timeSignature == "2/2"
    assert bundle.meta.beatsPerMeasure == 4
    assert bundle.meta.measureCount == 4
    assert [event.measureNo for event in bundle.events] == [1, 2, 3, 4]
    assert [event.pitches for event in bundle.events] == [[60], [62], [60], [62]]
    assert len({event.eventId for event in bundle.events}) == 4


def test_musicxml_meter_change_preserves_absolute_timeline_for_analysis():
    xml = b'''<?xml version="1.0"?>
    <score-partwise version="3.1">
      <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
          <note><rest/><duration>2</duration><type>half</type></note></measure>
        <measure number="2"><attributes><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
          <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
          <note><rest/><duration>1</duration><type>quarter</type></note></measure>
        <measure number="3"><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
          <note><rest/><duration>1</duration><type>quarter</type></note></measure>
      </part>
    </score-partwise>'''
    bundle = parse_musicxml(xml, "changing_meter")

    assert [event.absoluteBeat for event in bundle.events] == [0, 3, 5]
    performance = [PerformanceEvent(
        id=f"played-{index}", tOnMs=beat * 625, tOffMs=beat * 625 + 300,
        pitch=event.pitches[0], velocity=72, source="web-midi",
    ) for index, (event, beat) in enumerate(zip(bundle.events, [0, 3, 5]))]
    report = run_analysis(
        bundle, performance, "rep_meter", "sess_meter", range_start=1, range_end=3)

    assert report.metrics.pitchScore == 100
    assert not [error for error in report.errors if error.type.value in {
        "wrong_pitch", "missed_note", "extra_note", "early_late",
    }]


def test_pdf_slot_and_oversized_upload_fail_clearly(monkeypatch):
    with TestClient(app) as client:
        # A PDF now goes to the page reader. With no model configured the app
        # must say exactly that, rather than failing as if the file were broken.
        monkeypatch.setattr(config, "VISION_API_KEY", "")
        pdf = client.post("/api/v1/scores/import", files={
            "file": ("scan.pdf", b"%PDF-1.7\n", "application/pdf"),
        })
        assert pdf.status_code == 400
        assert "识谱模型" in pdf.json()["detail"]["message"]

        monkeypatch.setattr(config, "MAX_SCORE_BYTES", 8)
        oversized = client.post("/api/v1/scores/import", files={
            "file": ("large.mid", b"MThd" + b"0" * 20, "audio/midi"),
        })
        assert oversized.status_code == 400
        assert oversized.json()["detail"]["code"] == "SCORE_LIMIT_EXCEEDED"


def test_event_batches_are_idempotent_and_finish_returns_persistent_job(monkeypatch):
    suffix = uuid.uuid4().hex[:8]
    events = [event.model_dump() for event in load_midi_events(
        str(FIXTURES / "midi" / "melody__standard.mid"))]
    with TestClient(app) as client:
        session = client.post("/api/v1/sessions", json={
            "scoreId": "melody", "rangeStart": 1, "rangeEnd": 8,
            "device": "mock-midi",
        }).json()
        session_id = session["sessionId"]
        payload = {"batchId": f"browser-{suffix}", "sequence": 1, "events": events}
        first = client.post(f"/api/v1/sessions/{session_id}/event-batches", json=payload)
        repeated = client.post(f"/api/v1/sessions/{session_id}/event-batches", json=payload)
        assert first.status_code == 200 and first.json()["accepted"] is True
        assert repeated.status_code == 200 and repeated.json()["accepted"] is False

        changed = {**payload, "events": [{**events[0], "velocity": 1}]}
        conflict = client.post(f"/api/v1/sessions/{session_id}/event-batches", json=changed)
        assert conflict.status_code == 409

        conflicting_event_id = client.post(
            f"/api/v1/sessions/{session_id}/event-batches",
            json={
                "batchId": f"different-batch-{suffix}", "sequence": 2,
                "events": [{**events[0], "velocity": 2}],
            },
        )
        assert conflicting_event_id.status_code == 409
        assert conflicting_event_id.json()["detail"]["code"] == "EVENT_ID_CONFLICT"

        finish = client.post(f"/api/v1/sessions/{session_id}/finish", json={"events": []})
        assert finish.status_code == 202
        repeated_finish = client.post(f"/api/v1/sessions/{session_id}/finish", json={"events": []})
        assert repeated_finish.json()["analysisJobId"] == finish.json()["analysisJobId"]
        job_id = finish.json()["analysisJobId"]
        for _ in range(100):
            job = client.get(f"/api/v1/analysis/{job_id}").json()
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(0.03)
        assert job["status"] == "completed", job
        assert client.get(f"/api/v1/reports/{job['reportId']}").status_code == 200

        def fake_plan(_report, note, selected_error_ids, current, score_parts,
                      recent_plans=None):
            assert note == "控制在五分钟"
            # Regression: top-level errorIds must reach the planner params.
            assert current.errorIds == ["client-selected-error"]
            assert selected_error_ids == ["client-selected-error"]
            assert score_parts
            assert isinstance(recent_plans, list)
            return ExercisePlanOutcome(
                response=ExercisePlannerResponse(
                    title="五分钟节拍练习", strategy="beat_skeleton", errorIds=[],
                    tempoRatio=0.7, loopCount=3, hands=None,
                    rationale="先保留拍点骨架。", noteAcknowledgement="已采用五分钟要求。",
                ),
                provider="fake-ai", model="fake-model", response_mode="json_schema",
                latency_ms=12,
            )

        monkeypatch.setattr(mentor_adapter, "plan_exercise", fake_plan)
        generated = client.post("/api/v1/exercises", json={
            "reportId": job["reportId"], "errorIds": ["client-selected-error"],
            "params": {"strategy": "auto", "tempoRatio": 0.6, "loopCount": 4},
            "aiAssist": True, "generationNote": "控制在五分钟",
        })
        assert generated.status_code == 201, generated.text
        assert generated.json()["plannerProvider"] == "fake-ai"
        assert generated.json()["aiPlan"]["strategy"] == "beat_skeleton"
        assert set(generated.json()["cadencePlan"]) == {
            "half", "deceptive", "plagal", "authentic",
        }
        restored = client.get(
            f"/api/v1/exercises/{generated.json()['exerciseId']}")
        assert restored.status_code == 200, restored.text
        assert restored.json()["musicXmlUrl"] == generated.json()["musicXmlUrl"]
        assert restored.json()["aiPlan"] == generated.json()["aiPlan"]
        assert restored.json()["cadencePlan"] == generated.json()["cadencePlan"]

        practice_score_id = generated.json()["practiceScoreId"]
        practice = client.get(f"/api/v1/scores/{practice_score_id}")
        assert practice.status_code == 200, practice.text
        practice_body = practice.json()
        assert practice_body["generated"] is True
        assert practice_body["libraryCategory"] == "generated"
        assert practice_body["parentScoreId"] == "melody"
        assert practice_body["rootScoreId"] == "melody"
        assert practice_body["lineageDepth"] == 1
        assert practice_body["metadata"]["measureCount"] >= 5
        assert generated.json()["musicalFingerprint"]
        assert practice_body["timelineUrl"]
        assert client.get(practice_body["renderUrl"]).status_code == 200
        assert client.get(practice_body["timelineUrl"]).status_code == 200

        # A generated score is a complete session/diagnosis target, not only an
        # artifact preview. Build a clean take directly from its normalized events.
        practice_meta = practice_body["metadata"]
        beat_ms = 60_000 / practice_meta["tempo"]
        practice_events = []
        for event_index, score_event in enumerate(practice_body["scoreEvents"]):
            absolute_beat = ((score_event["measureNo"] - 1) *
                             practice_meta["beatsPerMeasure"] +
                             score_event["onsetBeat"])
            for pitch_index, pitch in enumerate(score_event["pitches"]):
                onset_ms = absolute_beat * beat_ms
                practice_events.append({
                    "id": f"round-{event_index}-{pitch_index}",
                    "tOnMs": onset_ms,
                    "tOffMs": onset_ms + score_event["durationBeat"] * beat_ms,
                    "pitch": pitch, "velocity": 72, "channel": 0,
                    "source": "test", "pedalDown": False,
                })
        round_session = client.post("/api/v1/sessions", json={
            "scoreId": practice_score_id, "rangeStart": 1,
            "rangeEnd": practice_meta["measureCount"], "device": "mock-midi",
        })
        assert round_session.status_code == 201, round_session.text
        round_finish = client.post(
            f"/api/v1/sessions/{round_session.json()['sessionId']}/finish",
            json={"events": practice_events},
        )
        assert round_finish.status_code == 202, round_finish.text
        round_job_id = round_finish.json()["analysisJobId"]
        for _ in range(100):
            round_job = client.get(f"/api/v1/analysis/{round_job_id}").json()
            if round_job["status"] in {"completed", "failed"}:
                break
            time.sleep(0.03)
        assert round_job["status"] == "completed", round_job
        round_report = client.get(
            f"/api/v1/reports/{round_job['reportId']}").json()
        assert round_report["scoreId"] == practice_score_id

        lineage_comparison = client.get("/api/v1/comparisons", params={
            "baselineId": job["reportId"], "retryId": round_report["reportId"],
        })
        assert lineage_comparison.status_code == 200, lineage_comparison.text
        assert lineage_comparison.json()["targetChanged"] is True

        next_exercise = client.post("/api/v1/exercises", json={
            "reportId": round_report["reportId"], "errorIds": [],
            "params": {"strategy": "auto", "tempoRatio": 0.6, "loopCount": 2},
            "aiAssist": False,
        })
        assert next_exercise.status_code == 201, next_exercise.text
        next_score = client.get(
            f"/api/v1/scores/{next_exercise.json()['practiceScoreId']}").json()
        assert next_score["parentScoreId"] == practice_score_id
        assert next_score["rootScoreId"] == "melody"
        assert next_score["lineageDepth"] == 2
        assert (next_exercise.json()["musicalFingerprint"] !=
                generated.json()["musicalFingerprint"])

        cleared = client.delete("/api/v1/scores/generated")
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["clearedCount"] >= 2
        visible_ids = {item["scoreId"] for item in
                       client.get("/api/v1/scores").json()["scores"]}
        assert practice_score_id not in visible_ids
        # Archiving the library entry never breaks an immutable old report.
        assert client.get(f"/api/v1/scores/{practice_score_id}").status_code == 200


def test_discarded_session_rejects_http_finish_and_websocket_events():
    event = load_midi_events(str(FIXTURES / "midi" / "melody__standard.mid"))[0]
    with TestClient(app) as client:
        session = client.post("/api/v1/sessions", json={
            "scoreId": "melody", "rangeStart": 1, "rangeEnd": 1,
            "device": "mock-midi",
        }).json()
        session_id = session["sessionId"]
        assert client.delete(f"/api/v1/sessions/{session_id}").status_code == 204

        finish = client.post(
            f"/api/v1/sessions/{session_id}/finish",
            json={"events": [event.model_dump()]},
        )
        assert finish.status_code == 409
        assert finish.json()["detail"]["code"] == "SESSION_CLOSED"

        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(
                    f"/api/v1/ws/sessions/{session_id}/events") as websocket:
                websocket.receive_json()
        assert closed.value.code == 4409


def test_failed_analysis_retry_is_queued_and_clears_stale_error():
    events = [event.model_dump() for event in load_midi_events(
        str(FIXTURES / "midi" / "melody__standard.mid"))]
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={
            "scoreId": "melody", "rangeStart": 1, "rangeEnd": 8,
            "device": "mock-midi",
        })
        assert created.status_code == 201, created.text
        session_id = created.json()["sessionId"]
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        repositories.save_job(job_id, {
            "sessionId": session_id, "status": "failed", "progress": 100,
            "errorCode": "ALIGNMENT_LOW_CONFIDENCE",
            "errorMessage": "stale failure", "attempts": 1,
        })

        retried = client.post(
            f"/api/v1/sessions/{session_id}/finish", json={"events": events})
        assert retried.status_code == 202, retried.text
        assert retried.json()["status"] != "failed"

        for _ in range(100):
            job = client.get(f"/api/v1/analysis/{job_id}").json()
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(0.03)
        assert job["status"] == "completed", job
        assert job["errorCode"] is None
        assert job["errorMessage"] is None


def test_movement_title_only_score_keeps_its_name():
    """Most engraving software exports <movement-title> and no <work-title>.
    Such a file used to show its internal ID in the library instead of its name."""
    from app.services.score_import import parse_musicxml

    xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1"><movement-title>小星星</movement-title>
<part-list><score-part id="P1"><part-name>Right Hand</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions>
<key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
<clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
</measure></part></score-partwise>"""

    bundle = parse_musicxml(xml.encode(), "twinkle_star")
    assert bundle.meta.title == "小星星"


def test_demo_songs_import_with_their_printed_tempo():
    """The four demo songs must arrive with the tempo written on the page."""
    from pathlib import Path
    from app.services.score_import import parse_musicxml

    fixtures = Path(__file__).resolve().parents[2] / "packages" / "score-fixtures" / "scores"
    expected = {
        "twinkle_star": ("小星星", 92.0, 12),
        "ode_to_joy": ("欢乐颂", 100.0, 8),
        "two_tigers": ("两只老虎", 108.0, 8),
        "jasmine_flower": ("茉莉花", 76.0, 8),
    }
    for score_id, (title, tempo, bars) in expected.items():
        bundle = parse_musicxml((fixtures / f"{score_id}.musicxml").read_bytes(), score_id)
        assert bundle.meta.title == title
        assert bundle.meta.tempo == tempo
        assert bundle.meta.measureCount == bars
        assert {event.part for event in bundle.events} == {"RH", "LH"}
