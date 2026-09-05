"""A rolled chord is one timing remark, not a pile of wrong notes.

Chord tones do not arrive on the same millisecond. An amateur spreads them by
accident and a romantic score spreads them on purpose, so a chord routinely
reaches the aligner as several performance groups. Reporting each late tone as
an extra note — and the tone it failed to match as a wrong note — turns one
piece of ordinary playing into a page of red.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.schemas.models import (ErrorType, PerformanceEvent, ScoreBundle,  # noqa: E402
                                ScoreEvent, ScoreMeta)
from app.services.diagnosis.pipeline import run_analysis  # noqa: E402

CHORD = [60, 64, 67]


def _bundle() -> ScoreBundle:
    """Four bars of the same triad, one per bar, at 120 BPM."""
    events = [
        ScoreEvent(
            eventId=f"rolled:RH:m{bar + 1}:b0",
            measureNo=bar + 1, onsetBeat=0.0, durationBeat=4,
            pitches=list(CHORD), part="RH",
        )
        for bar in range(4)
    ]
    return ScoreBundle(meta=ScoreMeta(
        scoreId="rolled", title="Rolled chord", tempo=120,
        timeSignature="4/4", beatsPerMeasure=4, measureCount=4,
        parts=["RH"], scoreHash="rolled-chord-v1",
    ), events=events)


def _note(identifier: str, onset_ms: float, pitch: int,
          confidence: float = .9) -> PerformanceEvent:
    return PerformanceEvent(
        id=identifier, tOnMs=onset_ms, tOffMs=onset_ms + 1800,
        pitch=pitch, velocity=76, source="microphone",
        transcriptionConfidence=confidence,
    )


def _run(performance: list[PerformanceEvent]):
    return run_analysis(
        _bundle(), performance, "rolled-report", "rolled-session",
        input_source="microphone", instrument="piano",
    )


def _of_type(report, error_type: ErrorType) -> list:
    return [e for e in report.errors if e.type == error_type]


def _bar_events(bar: int, spread: list[float]) -> list[PerformanceEvent]:
    """One chord at the top of `bar`, its tones spread by `spread` ms."""
    base = bar * 2000.0
    return [_note(f"m{bar}-{i}", base + offset, pitch)
            for i, (pitch, offset) in enumerate(zip(CHORD, spread))]


def test_chord_rolled_across_three_groups_is_one_timing_remark():
    """0 / 100 / 200 ms splits into three groups at a 90 ms window.

    Absorbing only the first late tone leaves the third reported twice — once
    as an extra note it never was, once as a wrong note that was in fact played.
    """
    performance: list[PerformanceEvent] = []
    for bar in range(4):
        performance += _bar_events(bar, [0.0, 100.0, 200.0])

    report = _run(performance)

    assert _of_type(report, ErrorType.extra_note) == []
    assert _of_type(report, ErrorType.wrong_pitch) == []
    assert _of_type(report, ErrorType.missed_note) == []
    # The spread is real playing information, so it is still reported — once
    # per chord, at low severity, not once per tone.
    late = _of_type(report, ErrorType.early_late)
    assert len(late) <= 4, f"one chord should not yield several remarks: {late}"


def test_ghost_tone_in_a_late_group_does_not_restore_the_cascade():
    """Onsets & Frames reports a harmonic alongside a real tone.

    The late group is then {67, 79} while only 67 is missing. Demanding that
    the whole group be a subset of the missing pitches abandons it, and both
    false errors come back.
    """
    performance: list[PerformanceEvent] = []
    for bar in range(4):
        performance += _bar_events(bar, [0.0, 100.0, 200.0])
        # An octave ghost riding along with the late G.
        performance.append(_note(f"m{bar}-ghost", bar * 2000.0 + 200.0, 79))

    report = _run(performance)

    assert _of_type(report, ErrorType.wrong_pitch) == []
    assert _of_type(report, ErrorType.missed_note) == []
    # The ghost itself is genuinely not in the score, so it may be reported as
    # an extra note — but only the ghost, never the real chord tone with it.
    for error in _of_type(report, ErrorType.extra_note):
        facts = " ".join(
            e.fact for e in report.evidences if e.id in error.evidenceIds)
        assert "67" not in facts, f"real chord tone reported as extra: {facts}"


def test_a_simultaneous_chord_is_still_clean():
    """The fix must not make a well-played chord report anything."""
    performance: list[PerformanceEvent] = []
    for bar in range(4):
        performance += _bar_events(bar, [0.0, 4.0, 8.0])

    report = _run(performance)

    assert _of_type(report, ErrorType.extra_note) == []
    assert _of_type(report, ErrorType.wrong_pitch) == []
    assert _of_type(report, ErrorType.missed_note) == []
    assert _of_type(report, ErrorType.early_late) == []


def test_a_genuinely_wrong_note_is_still_caught():
    """Guard against the absorption swallowing real mistakes."""
    performance: list[PerformanceEvent] = []
    for bar in range(4):
        base = bar * 2000.0
        # F natural instead of E: a wrong note, not a spread chord.
        performance += [_note(f"m{bar}-0", base, 60),
                        _note(f"m{bar}-1", base + 4, 65),
                        _note(f"m{bar}-2", base + 8, 67)]

    report = _run(performance)
    assert _of_type(report, ErrorType.wrong_pitch), "a wrong note must survive"
