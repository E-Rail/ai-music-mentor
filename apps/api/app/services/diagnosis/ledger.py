"""The report being written: every mistake and the evidence behind it.

Every rule that finds something — a wrong note, a pause, a staccato held too
long — writes it here, so ids stay unique across rules and every sentence names
bars the way the page prints them.
"""
from __future__ import annotations

from app.i18n import Msg, localized
from app.schemas.models import ErrorEvent, ErrorType, Evidence, Severity
from app.services.alignment.onset import ScoreOnset
from app.services.diagnosis.confidence import confidence

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def pitch_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def pitch_set_str(pitches) -> str:
    return "/".join(pitch_name(p) for p in sorted(pitches))


class Ledger:
    def __init__(self, measure_labels: list[str] | None = None):
        self.errors: list[ErrorEvent] = []
        self.evidences: list[Evidence] = []
        self._err_n = 0
        self._ev_n = 0
        self._labels = measure_labels or []

    def label(self, measure: int) -> str:
        """What the page calls this bar.

        ``measureNo`` is a position in the timeline and always counts 1, 2, 3…,
        which is what alignment and event IDs need. It is not what is printed:
        a piece that opens with a pickup numbers that bar 0, so every printed
        number after it is one lower. location.measure keeps the position — the
        interface relabels that itself — but a sentence a student reads has to
        say the number on their page, or it sends them to the wrong bar.
        """
        if 1 <= measure <= len(self._labels):
            return self._labels[measure - 1]
        return str(measure)

    def add_evidence(self, measure: int, beat: float, fact: Msg,
                     expected: Msg | str = "", actual: Msg | str = "",
                     delta_ms: float | None = None,
                     delta_velocity: float | None = None,
                     expected_pitches=(), actual_pitches=()) -> str:
        self._ev_n += 1
        ev_id = f"ev_{self._ev_n:04d}"
        self.evidences.append(Evidence(
            id=ev_id, measureNo=measure, beat=beat, deltaMs=delta_ms,
            deltaVelocity=delta_velocity,
            expectedPitches=sorted(expected_pitches),
            actualPitches=sorted(actual_pitches),
            **localized(fact=fact, expected=expected, actual=actual)))
        return ev_id

    def add_error(self, err_type: ErrorType, measure: int, beat: float,
                  event_ids: list[str], severity: Severity,
                  evidence_ids: list[str], detail: Msg | str = "") -> None:
        self._err_n += 1
        conf = confidence(err_type, len(evidence_ids), 1)
        self.errors.append(ErrorEvent(
            id=f"err_{self._err_n:04d}", type=err_type,
            location={"measure": measure, "beat": beat,
                      "eventId": event_ids[0] if event_ids else None,
                      "eventIds": event_ids},
            severity=severity, evidenceIds=evidence_ids, confidence=conf,
            **localized(detail=detail)))

    def at(self, o: ScoreOnset) -> dict[str, str]:
        """The printed bar and beat of an onset, as message parameters."""
        return {"bar": self.label(o.measureNo), "beat": f"{o.onsetBeat + 1:g}"}

    def span(self, first: int, last: int) -> dict[str, str]:
        """A run of bars as message parameters."""
        return {"start": self.label(first), "end": self.label(last)}
