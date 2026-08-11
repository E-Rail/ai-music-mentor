"""Evaluate exported note JSON without committing third-party audio.

Input JSON files contain [{"pitch": 60, "onsetMs": 123.4}, ...]. Matching is
one-to-one by pitch within the configured onset tolerance.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def note_f1(reference: list[dict], predicted: list[dict], tolerance_ms: float) -> dict:
    used: set[int] = set()
    true_positive = 0
    for expected in reference:
        candidates = [
            (abs(float(actual["onsetMs"]) - float(expected["onsetMs"])), index)
            for index, actual in enumerate(predicted)
            if index not in used and int(actual["pitch"]) == int(expected["pitch"])
            and abs(float(actual["onsetMs"]) - float(expected["onsetMs"])) <= tolerance_ms
        ]
        if candidates:
            _, index = min(candidates)
            used.add(index)
            true_positive += 1
    false_positive = len(predicted) - true_positive
    false_negative = len(reference) - true_positive
    precision = true_positive / max(1, true_positive + false_positive)
    recall = true_positive / max(1, true_positive + false_negative)
    f1 = 2 * precision * recall / max(1e-12, precision + recall)
    return {"tp": true_positive, "fp": false_positive, "fn": false_negative,
            "precision": precision, "recall": recall, "f1": f1}


def evaluate_gate(reference: list[dict], predicted: list[dict],
                  tolerance_ms: float, minimum_f1: float,
                  noisy_predicted: list[dict] | None = None,
                  max_noise_drop: float = .15) -> dict:
    clean = note_f1(reference, predicted, tolerance_ms)
    noisy = (note_f1(reference, noisy_predicted, tolerance_ms)
             if noisy_predicted is not None else None)
    noise_drop = max(0.0, clean["f1"] - noisy["f1"]) if noisy else None
    passed = clean["f1"] >= minimum_f1 and (
        noise_drop is None or noise_drop <= max_noise_drop)
    return {
        "passed": passed, "minimumF1": minimum_f1,
        "maxNoiseF1Drop": max_noise_drop, "noiseF1Drop": noise_drop,
        "clean": clean, "noisy20Db": noisy,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("predicted", type=Path)
    parser.add_argument("--tolerance-ms", type=float, default=100)
    parser.add_argument("--minimum-f1", type=float, default=0)
    parser.add_argument("--noisy-predicted", type=Path)
    parser.add_argument("--max-noise-f1-drop", type=float, default=.15)
    args = parser.parse_args()
    result = evaluate_gate(
        json.loads(args.reference.read_text()),
        json.loads(args.predicted.read_text()), args.tolerance_ms,
        args.minimum_f1,
        (json.loads(args.noisy_predicted.read_text())
         if args.noisy_predicted else None),
        args.max_noise_f1_drop,
    )
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["passed"] else 1)
