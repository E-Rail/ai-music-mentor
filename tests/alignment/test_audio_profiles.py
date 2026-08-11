from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.schemas.models import (PerformanceEvent, ScoreBundle, ScoreEvent,
                                ScoreMeta)  # noqa: E402
from app.services.alignment.grouping import group_chord_onsets  # noqa: E402
from app.services.diagnosis.pipeline import run_analysis  # noqa: E402
from app.services.diagnosis.profiles import accepted_events, resolve_profile  # noqa: E402
from app.services.generation.score_build import events_to_musicxml  # noqa: E402
from app.services.score_import import _written_to_sounding_semitones  # noqa: E402


def _event(identifier: str, onset: float, pitch: int,
           confidence: float = .9) -> PerformanceEvent:
    return PerformanceEvent(
        id=identifier, tOnMs=onset, tOffMs=onset + 200,
        pitch=pitch, velocity=80, source="microphone",
        transcriptionConfidence=confidence,
    )


def test_chord_window_is_anchored_to_first_onset_not_chained():
    groups = group_chord_onsets([
        _event("a", 0, 60), _event("b", 60, 64), _event("c", 120, 67),
    ], window_ms=70, bpm=96)
    assert [group.pitches for group in groups] == [[60, 64], [67]]


def test_audio_profile_filters_confidence_and_instrument_range():
    profile = resolve_profile("microphone", "violin")
    accepted, rejected = accepted_events([
        _event("good", 0, 69, .8),
        _event("weak", 300, 71, .2),
        _event("outside", 600, 40, .95),
    ], profile)
    assert [event.id for event in accepted] == ["good"]
    assert rejected == 2
    assert profile.include_duration_errors is True
    assert profile.duration_tolerance == .80
    assert profile.profile_id == "audio-violin-v2"


def test_musicxml_octave_transpose_is_explicit_not_guessed():
    marked = b"""<score-partwise><part><measure><attributes><transpose>
      <diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change>
    </transpose></attributes></measure></part></score-partwise>"""
    unmarked = b"<score-partwise><part><measure /></part></score-partwise>"
    assert _written_to_sounding_semitones(marked) == -12
    assert _written_to_sounding_semitones(unmarked) == 0


def test_guitar_microphone_uses_written_pitch_for_marked_score():
    score_events = [
        ScoreEvent(eventId=f"guitar:m1:{index}", measureNo=1,
                   onsetBeat=float(index), durationBeat=.5,
                   pitches=[pitch], part="RH")
        for index, pitch in enumerate([64, 65, 67, 69])
    ]
    bundle = ScoreBundle(meta=ScoreMeta(
        scoreId="guitar", title="Guitar", tempo=96, measureCount=1,
        writtenToSoundingSemitones=-12, scoreHash="guitar-test",
    ), events=score_events)
    performance = [
        _event(f"take-{index}", index * 625, pitch - 12, .92)
        for index, pitch in enumerate([64, 65, 67, 69])
    ]
    report = run_analysis(
        bundle, performance, "guitar-report", "guitar-session",
        input_source="microphone", instrument="guitar",
        capture_meta={"meanConfidence": .92, "acceptedNoteCount": 4},
    )
    assert report.metrics.pitchScore == 100
    assert not report.errors
    assert any("书写音高" in warning for warning in report.warnings)


def test_generated_guitar_score_preserves_octave_transposition(tmp_path):
    meta = ScoreMeta(
        scoreId="generated-guitar", title="Generated guitar", tempo=80,
        measureCount=1, scoreHash="generated-guitar-test",
    )
    events = [
        ScoreEvent(eventId="generated-guitar:m1:0", measureNo=1,
                   onsetBeat=0, durationBeat=1, pitches=[64], part="RH"),
    ]
    output = tmp_path / "guitar.musicxml"

    events_to_musicxml(events, meta, 80, "Guitar exercise", output, "guitar")

    assert _written_to_sounding_semitones(output.read_bytes()) == -12
