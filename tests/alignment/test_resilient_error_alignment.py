"""Wrong and accidental notes must stay local instead of invalidating a take."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.schemas.models import (ErrorType, PerformanceEvent, ScoreBundle,  # noqa: E402
                                ScoreEvent, ScoreMeta)
from app.services.diagnosis.pipeline import run_analysis  # noqa: E402


SCORE_PITCHES = [60, 62, 64, 65, 67, 69, 71, 72,
                 71, 69, 67, 65, 64, 62, 60, 62]


def _bundle() -> ScoreBundle:
    events = [
        ScoreEvent(
            eventId=f"resilient:RH:m{index // 4 + 1}:b{index % 4}",
            measureNo=index // 4 + 1,
            onsetBeat=float(index % 4),
            durationBeat=1,
            pitches=[pitch],
            part="RH",
        )
        for index, pitch in enumerate(SCORE_PITCHES)
    ]
    return ScoreBundle(meta=ScoreMeta(
        scoreId="resilient", title="Resilient alignment", tempo=120,
        timeSignature="4/4", beatsPerMeasure=4, measureCount=4,
        parts=["RH"], scoreHash="resilient-alignment-v1",
    ), events=events)


def _note(identifier: str, onset_ms: float, pitch: int) -> PerformanceEvent:
    return PerformanceEvent(
        id=identifier, tOnMs=onset_ms, tOffMs=onset_ms + 420,
        pitch=pitch, velocity=76, source="web-midi",
    )


def test_ten_wrong_notes_and_one_accidental_note_still_produce_local_errors():
    wrong_indices = {1, 2, 3, 5, 6, 8, 9, 10, 12, 13}
    performance = [
        _note(
            f"played-{index}", index * 500,
            88 + index if index in wrong_indices else pitch,
        )
        for index, pitch in enumerate(SCORE_PITCHES)
    ]
    # A distinct accidental press between two intended notes must be an insert,
    # not a reason to shift every subsequent score position.
    performance.append(_note("accidental", 7_250, 105))

    report = run_analysis(
        _bundle(), performance, "resilient-report", "resilient-session")

    wrong = [error for error in report.errors
             if error.type == ErrorType.wrong_pitch]
    extra = [error for error in report.errors
             if error.type == ErrorType.extra_note]
    missed = [error for error in report.errors
              if error.type == ErrorType.missed_note]
    assert len(wrong) == len(wrong_indices)
    assert len(extra) == 1
    assert not missed
    assert report.metrics.matchedCount == len(SCORE_PITCHES)
    assert report.inputQuality.status in {"high", "medium"}
    assert report.metrics.pitchScore < 50


def test_simultaneous_accidental_pitch_does_not_corrupt_following_alignment():
    performance = [
        _note(f"played-{index}", index * 500, pitch)
        for index, pitch in enumerate(SCORE_PITCHES)
    ]
    performance.append(_note("fat-finger", 3_010, 81))

    report = run_analysis(
        _bundle(), performance, "fat-finger-report", "fat-finger-session")

    pitch_errors = [error for error in report.errors if error.type in {
        ErrorType.wrong_pitch, ErrorType.missed_note, ErrorType.extra_note,
    }]
    assert [error.type for error in pitch_errors] == [ErrorType.extra_note]
    assert pitch_errors[0].location["measure"] == 2
    assert report.metrics.matchedCount == len(SCORE_PITCHES)


def test_wrong_press_then_pause_and_correction_relocks_without_cascade():
    performance = [
        _note("played-0", 0, SCORE_PITCHES[0]),
        _note("played-1", 500, SCORE_PITCHES[1]),
        _note("played-2", 1_000, SCORE_PITCHES[2]),
        _note("wrong-press", 1_500, 83),
        # The player pauses, corrects the target note, then continues at a
        # slower but stable tempo. Later notes must keep their score positions.
        _note("correction", 5_500, SCORE_PITCHES[3]),
        *[
            _note(f"played-{index}", 5_500 + (index - 3) * 800, pitch)
            for index, pitch in enumerate(SCORE_PITCHES[4:], start=4)
        ],
    ]

    report = run_analysis(
        _bundle(), performance, "pause-report", "pause-session")

    pitch_errors = [error for error in report.errors if error.type in {
        ErrorType.wrong_pitch, ErrorType.missed_note, ErrorType.extra_note,
    }]
    assert [error.type for error in pitch_errors] == [ErrorType.extra_note]
    assert report.metrics.matchedCount == len(SCORE_PITCHES)
    assert report.inputQuality.status == "high"


def test_velocity_difference_is_localized_without_affecting_note_alignment():
    bundle = _bundle()
    # A score written "mf" throughout: 72 is the notated-dynamic velocity, and
    # only a notated marking licenses grading the player against it.
    bundle.meta.hasNotatedDynamics = True
    bundle.events = [event.model_copy(update={"dynamicTarget": 72})
                     for event in bundle.events]
    performance = [
        PerformanceEvent(
            id=f"velocity-{index}", tOnMs=index * 500,
            tOffMs=index * 500 + 420, pitch=pitch,
            velocity=110 if index == 6 else 72, source="web-midi",
        )
        for index, pitch in enumerate(SCORE_PITCHES)
    ]

    report = run_analysis(
        bundle, performance, "velocity-report", "velocity-session")

    dynamics = [error for error in report.errors
                if error.type == ErrorType.dynamics_anomaly]
    pitch_errors = [error for error in report.errors if error.type in {
        ErrorType.wrong_pitch, ErrorType.missed_note, ErrorType.extra_note,
    }]
    assert len(dynamics) == 1
    assert dynamics[0].location["measure"] == 2
    evidence = next(item for item in report.evidences
                    if item.id in dynamics[0].evidenceIds)
    assert evidence.deltaVelocity == 38
    assert "110" in evidence.fact and "72" in evidence.fact
    assert not pitch_errors
    assert report.metrics.matchedCount == len(SCORE_PITCHES)
    assert report.metrics.dynamicsScore < 100


def _perfect_take(velocity: int, confidence: float | None = None,
                  source: str = "web-midi") -> list[PerformanceEvent]:
    """A pitch-perfect, metronomically perfect performance."""
    return [
        PerformanceEvent(
            id=f"perfect-{index}", tOnMs=index * 500,
            tOffMs=index * 500 + 420, pitch=pitch, velocity=velocity,
            source=source, transcriptionConfidence=confidence,
        )
        for index, pitch in enumerate(SCORE_PITCHES)
    ]


def test_midi_import_velocities_are_not_graded_as_written_dynamics():
    """A MIDI file's note velocities record how someone played, not an
    instruction on the page. Grading against them flagged every note of a
    flawless take."""
    bundle = _bundle()
    # What the MIDI importer stamps on every event: a recorded velocity.
    bundle.events = [event.model_copy(update={"dynamicTarget": 64})
                     for event in bundle.events]
    assert bundle.meta.hasNotatedDynamics is False

    report = run_analysis(bundle, _perfect_take(95),
                          "midi-dyn-report", "midi-dyn-session")

    dynamics = [error for error in report.errors
                if error.type == ErrorType.dynamics_anomaly]
    assert dynamics == []
    assert report.metrics.dynamicsScore == 100
    assert report.metrics.overallScore == 100


def test_microphone_amplitude_is_not_scored_as_midi_velocity():
    """Basic Pitch reports amplitude, not velocity. Scoring a quiet-looking
    transcription against a written dynamic deducted points no error explained."""
    bundle = _bundle()
    bundle.meta.hasNotatedDynamics = True
    bundle.events = [event.model_copy(update={"dynamicTarget": 72})
                     for event in bundle.events]

    report = run_analysis(
        bundle, _perfect_take(25, confidence=0.9, source="microphone"),
        "mic-dyn-report", "mic-dyn-session",
        input_source="microphone", instrument="piano",
        capture_meta={"meanConfidence": 0.9},
    )

    assert [error for error in report.errors
            if error.type == ErrorType.dynamics_anomaly] == []
    assert report.metrics.dynamicsScore == 100
