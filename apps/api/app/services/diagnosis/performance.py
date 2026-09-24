"""The numbers behind a second look at a take.

A report lists what went wrong. A teacher listening again asks different
questions: is it one hand? Do the hands land together? How much of the
dynamic range was used, and is the melody on top? Everything here is measured
from the same alignment the mistakes came from, and none of it is a grade.
"""
from __future__ import annotations

import statistics

from typing import TYPE_CHECKING

from app.schemas.models import HandProfile, PerformanceProfile
from app.services.diagnosis.take import Take

if TYPE_CHECKING:
    from app.services.diagnosis.errors import Findings

#: Hands the page puts on one beat, and how few of them make a tendency.
MIN_LAG_SAMPLES = 3


def _percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(share * (len(ordered) - 1))))]


def profile(take: Take, findings: "Findings") -> PerformanceProfile:
    shaping = findings.shaping
    residuals: dict[str, list[float]] = {"RH": [], "LH": []}
    velocities: dict[str, list[float]] = {"RH": [], "LH": []}
    expected = {"RH": 0, "LH": 0}
    correct = {"RH": 0, "LH": 0}
    lags: list[float] = []

    for onset in take.ordered:
        # Where each written note went — the same record the mistakes used,
        # so a late left hand is late here too, not missing.
        arrived = findings.arrivals.get(onset.onsetId, {})
        landed: dict[str, float] = {}
        for member in onset.members:
            if member.optional or member.part not in expected:
                continue
            expected[member.part] += 1
            found = [pitch for pitch in member.pitches if pitch in arrived]
            if not found:
                continue
            if len(found) == len(set(member.pitches)):
                correct[member.part] += 1
            arrival = min(arrived[pitch][1] for pitch in found)
            landed[member.part] = min(arrival, landed.get(member.part, arrival))
            residuals[member.part].append(arrival - take.tempo_map.expected_ms(take.beat(onset)))
            velocities[member.part].extend(
                note.velocity for pitch in found
                for note in take.notes_in(take.groups[arrived[pitch][0]], [pitch])
                if note.velocity > 0)
        if "RH" in landed and "LH" in landed:
            lags.append(landed["LH"] - landed["RH"])

    hands = []
    for hand in ("RH", "LH"):
        if not expected[hand]:
            continue
        timing = residuals[hand]
        loudness = velocities[hand] if take.measures_dynamics else []
        hands.append(HandProfile(
            hand=hand, expected=expected[hand], correct=correct[hand],
            timingMaeMs=round(statistics.mean(abs(value) for value in timing), 1) if timing else None,
            timingBiasMs=round(statistics.median(timing), 1) if timing else None,
            medianVelocity=round(statistics.median(loudness), 1) if loudness else None,
        ))

    every_velocity = velocities["RH"] + velocities["LH"]
    balance = None
    if take.measures_dynamics and velocities["RH"] and velocities["LH"]:
        balance = round(statistics.median(velocities["RH"]) - statistics.median(velocities["LH"]), 1)
    return PerformanceProfile(
        hands=hands,
        handLagMs=round(statistics.median(lags), 1) if len(lags) >= MIN_LAG_SAMPLES else None,
        handLagSamples=len(lags),
        velocityRange=([round(_percentile(every_velocity, share), 1) for share in (0.1, 0.5, 0.9)]
                       if take.measures_dynamics and len(every_velocity) >= 4 else None),
        handBalance=balance,
        staccatoChecked=shaping.staccato_checked, staccatoMet=shaping.staccato_met,
        legatoChecked=shaping.legato_checked, legatoMet=shaping.legato_met,
        accentsChecked=shaping.accents_checked, accentsMet=shaping.accents_met,
        hairpinsChecked=shaping.hairpins_checked, hairpinsMet=shaping.hairpins_met,
        pedalledReleases=shaping.pedalled,
        hesitations=len(findings.after_pause), restarts=findings.replays,
    )
