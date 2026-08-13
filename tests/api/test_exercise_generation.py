"""Generated studies must develop the motif and avoid recent duplicates."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.schemas.models import ExerciseParams  # noqa: E402
from app.services.diagnosis.pipeline import run_analysis  # noqa: E402
from app.services.generation.exercises import generate_exercise  # noqa: E402
from app.services.midi_io import load_midi_events  # noqa: E402
from app.services.score_import import parse_musicxml  # noqa: E402


def test_repeated_generation_produces_developed_unique_musical_content():
    fixtures = ROOT / "packages" / "score-fixtures"
    bundle = parse_musicxml(
        (fixtures / "scores" / "melody.musicxml").read_bytes(), "melody")
    performance = load_midi_events(
        str(fixtures / "midi" / "melody__wrong_pitch.mid"))
    report = run_analysis(bundle, performance, "generation-report", "generation-session")
    params = ExerciseParams(strategy="chunk_connect", loopCount=2)

    with tempfile.TemporaryDirectory(prefix="exercise-variants-") as directory:
        exercises = [
            generate_exercise(report, bundle, params, Path(directory), index)
            for index in range(8)
        ]

    assert len({exercise.musicalFingerprint for exercise in exercises}) == 8
    assert all(len(exercise.sourceMeasures) >= 2 for exercise in exercises)
    assert all(exercise.variationIndex == index
               for index, exercise in enumerate(exercises))
    assert all(len(exercise.cadencePlan) == 4 for exercise in exercises)
    assert all(len(set(exercise.cadencePlan)) == 4 for exercise in exercises)


def test_one_exercise_contains_multiple_contrasting_cadences_and_real_development():
    fixtures = ROOT / "packages" / "score-fixtures"
    bundle = parse_musicxml(
        (fixtures / "scores" / "melody.musicxml").read_bytes(), "melody")
    performance = load_midi_events(
        str(fixtures / "midi" / "melody__wrong_pitch.mid"))
    report = run_analysis(bundle, performance, "cadence-report", "cadence-session")
    params = ExerciseParams(strategy="chunk_connect", loopCount=1)

    with tempfile.TemporaryDirectory(prefix="exercise-cadences-") as directory:
        exercise = generate_exercise(report, bundle, params, Path(directory), 0)
        generated = parse_musicxml(
            Path(exercise.musicXmlPath).read_bytes(), "generated-cadences")

    assert exercise.cadencePlan == [
        "half", "deceptive", "plagal", "authentic",
    ]
    assert generated.meta.measureCount >= 5
    by_measure = {
        measure: sorted(
            (event for event in generated.events if event.measureNo == measure),
            key=lambda event: event.onsetBeat,
        )
        for measure in range(2, 6)
    }
    # The fixture is in C major: the four phrase endings are V, vi, I, I.
    ending_pitch_classes = [
        {pitch % 12 for pitch in by_measure[measure][-1].pitches}
        for measure in range(2, 6)
    ]
    assert 7 in ending_pitch_classes[0]
    assert 9 in ending_pitch_classes[1]
    assert 0 in ending_pitch_classes[2]
    assert 0 in ending_pitch_classes[3]
