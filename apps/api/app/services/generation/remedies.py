"""Which practice fixes which kind of mistake — one table for the whole app.

The rules mentor, the AI mentor's candidates, the exercise planner and the
exercise generator each used to carry their own copy of this, and a new kind
of mistake had to be taught to all four. The first strategy in each row is the
default; the rest are what to try when the default was just used.
"""
from __future__ import annotations

from app.schemas.models import ErrorType

REMEDIES: dict[ErrorType, tuple[str, ...]] = {
    ErrorType.wrong_pitch: ("chunk_connect", "loop", "rhythm_variant"),
    ErrorType.missed_note: ("chunk_connect", "loop", "hands_separate"),
    ErrorType.extra_note: ("chunk_connect", "slow_ladder", "loop"),
    ErrorType.early_late: ("slow_ladder", "chunk_connect", "rhythm_variant"),
    ErrorType.tempo_instability: ("slow_ladder", "rhythm_variant", "chunk_connect"),
    ErrorType.duration_anomaly: ("rhythm_variant", "slow_ladder", "chunk_connect"),
    ErrorType.dynamics_anomaly: ("chunk_connect", "rhythm_variant", "loop"),
    # A stop is a join the hands do not know yet: practise across it, slowly,
    # until the notes either side belong to one gesture.
    ErrorType.hesitation: ("chunk_connect", "slow_ladder", "loop"),
}

FALLBACK: tuple[str, ...] = ("chunk_connect", "rhythm_variant", "slow_ladder")


def remedies_for(error_type: ErrorType | str | None) -> tuple[str, ...]:
    try:
        return REMEDIES[ErrorType(error_type)] if error_type else FALLBACK
    except ValueError:
        return FALLBACK


def remedy_for(error_type: ErrorType | str | None) -> str:
    return remedies_for(error_type)[0]
