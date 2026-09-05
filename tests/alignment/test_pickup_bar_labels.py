"""A report must name the bar the student's page names.

measureNo is a position in the performance timeline and always counts 1, 2, 3…
A piece that opens with a pickup numbers that bar 0 on the page, so every
printed number after it is one lower than its position. The interface relabels
the numeric badge, but the sentence beside it is built here — and if this file
uses the timeline number, the badge and the sentence disagree and the student is
sent to the wrong bar.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.schemas.models import (ErrorType, PerformanceEvent, ScoreBundle,  # noqa: E402
                                ScoreEvent, ScoreMeta)
from app.services.diagnosis.pipeline import run_analysis  # noqa: E402

# One pickup crotchet, then two full 4/4 bars. The page calls them 0, 1, 2;
# the timeline calls them 1, 2, 3.
LABELS = ["0", "1", "2"]


def _bundle() -> ScoreBundle:
    events = [ScoreEvent(eventId="pickup:RH:m1:b0", measureNo=1, onsetBeat=0.0,
                         absoluteBeat=0.0, durationBeat=1, pitches=[60], part="RH")]
    for bar in (2, 3):
        for beat in range(4):
            events.append(ScoreEvent(
                eventId=f"pickup:RH:m{bar}:b{beat}", measureNo=bar,
                onsetBeat=float(beat), absoluteBeat=1.0 + (bar - 2) * 4 + beat,
                durationBeat=1, pitches=[62 + beat], part="RH"))
    return ScoreBundle(meta=ScoreMeta(
        scoreId="pickup", title="Pickup", tempo=120, timeSignature="4/4",
        beatsPerMeasure=4, measureCount=3, parts=["RH"],
        scoreHash="pickup-v1", measureLabels=LABELS,
    ), events=events)


def _played(skip: str | None) -> list[PerformanceEvent]:
    """Play the piece, optionally omitting one note by event id."""
    out: list[PerformanceEvent] = []
    for index, event in enumerate(_bundle().events):
        if event.eventId == skip:
            continue
        onset = (event.absoluteBeat or 0.0) * 500
        out.append(PerformanceEvent(
            id=f"p{index}", tOnMs=onset, tOffMs=onset + 420,
            pitch=event.pitches[0], velocity=76, source="web-midi"))
    return out


def test_the_sentence_names_the_printed_bar_not_the_timeline_position():
    # Miss the first note of the bar the page calls "1" (timeline position 2).
    report = run_analysis(_bundle(), _played("pickup:RH:m2:b0"),
                          "pickup-report", "pickup-session")
    missed = [e for e in report.errors if e.type == ErrorType.missed_note]
    assert missed, "the omitted note should be reported"

    facts = " ".join(e.fact for e in report.evidences)
    assert "第 1 小节" in facts, f"should name the printed bar 1: {facts}"
    assert "第 2 小节" not in facts, (
        f"names the timeline position, which is not what the page prints: {facts}")


def test_the_badge_still_carries_the_timeline_position():
    # location.measure stays the position: alignment and the interface's own
    # relabelling both depend on it. Only the prose is relabelled.
    report = run_analysis(_bundle(), _played("pickup:RH:m2:b0"),
                          "pickup-report", "pickup-session")
    missed = [e for e in report.errors if e.type == ErrorType.missed_note]
    assert missed[0].location["measure"] == 2


def test_a_score_without_a_pickup_is_unchanged():
    bundle = _bundle()
    bundle.meta.measureLabels = ["1", "2", "3"]
    report = run_analysis(bundle, _played("pickup:RH:m2:b0"),
                          "plain-report", "plain-session")
    facts = " ".join(e.fact for e in report.evidences)
    assert "第 2 小节" in facts, facts


def test_a_score_with_no_labels_at_all_falls_back_to_the_position():
    bundle = _bundle()
    bundle.meta.measureLabels = []
    report = run_analysis(bundle, _played("pickup:RH:m2:b0"),
                          "nolabels-report", "nolabels-session")
    facts = " ".join(e.fact for e in report.evidences)
    assert "第 2 小节" in facts, facts
