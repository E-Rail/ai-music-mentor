import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evaluate_notes import evaluate_gate, note_f1  # noqa: E402


def test_note_f1_uses_one_to_one_pitch_and_onset_matching():
    reference = [{"pitch": 60, "onsetMs": 100}, {"pitch": 64, "onsetMs": 500}]
    predicted = [
        {"pitch": 60, "onsetMs": 180},
        {"pitch": 60, "onsetMs": 185},
        {"pitch": 64, "onsetMs": 720},
    ]

    result = note_f1(reference, predicted, 100)

    assert result["tp"] == 1
    assert result["fp"] == 2
    assert result["fn"] == 1


def test_gate_enforces_clean_f1_and_noise_drop():
    reference = [{"pitch": pitch, "onsetMs": index * 200}
                 for index, pitch in enumerate(range(60, 70))]
    clean = list(reference)
    noisy = reference[:7]

    passing = evaluate_gate(reference, clean, 100, .75, noisy, .20)
    failing = evaluate_gate(reference, clean, 100, .75, noisy, .15)

    assert passing["passed"] is True
    assert passing["noiseF1Drop"] < .20
    assert failing["passed"] is False
