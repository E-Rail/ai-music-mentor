"""How the notes were shaped against what the page marks.

Right notes at the right time are the start of reading a score, not the end of
it. The page also says how each note is played: short (staccato), joined
(slur), leaned on (accent), and growing or fading across a phrase (hairpins).
These rules hold a take to those marks, and only to marks that are written —
a phrase with no slur is not faulted for being detached.

Each rule needs the input to have measured what it judges. A key release is
only a release when a keyboard reports one; a microphone hears the piano's
decay. Loudness is only a MIDI velocity from a keyboard. Where the input cannot
tell, the rule stays silent rather than guessing.

Mistakes of one kind in one phrase are reported once for the phrase: sixteen
staccato quavers held too long are one habit, not sixteen findings.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field

from app.i18n import msg
from app.schemas.models import (ErrorType, PerformanceEvent, ScoreEvent,
                                Severity)
from app.services.alignment.onset import ScoreOnset
from app.services.diagnosis.ledger import Ledger
from app.services.diagnosis.take import SHORT_MARKS, Take

#: Staccato: the note sounds for at most this share of its written value.
STACCATO_SHARE = 0.6
STACCATISSIMO_SHARE = 0.45
#: Legato: a join may leave at most this much silence…
LEGATO_GAP_MS = 40.0
#: …or this share of the time between the two notes, whichever is larger.
LEGATO_GAP_SHARE = 0.1
#: An accent stands this far above the notes around it, in MIDI velocity.
ACCENT_LIFT = 8.0
MARCATO_LIFT = 12.0
#: How far either side of an accent its neighbours are drawn from, in beats.
ACCENT_NEIGHBOURHOOD = 2.0
#: A hairpin has to move the dynamic at least this far, in MIDI velocity.
HAIRPIN_CHANGE = 6.0
#: Findings closer than this, in beats, belong to one phrase.
PHRASE_GAP_BEATS = 4.0


@dataclass
class Shaping:
    """What was checked and what was met — the profile shows the tallies."""
    staccato_checked: int = 0
    staccato_met: int = 0
    legato_checked: int = 0
    legato_met: int = 0
    accents_checked: int = 0
    accents_met: int = 0
    hairpins_checked: int = 0
    hairpins_met: int = 0
    pedalled: int = 0
    #: Onsets the accent rule judged, so the take-relative loudness check does
    #: not call a written accent "suddenly louder".
    accented_onsets: set[str] = field(default_factory=set)


def judge_shaping(ledger: Ledger, take: Take) -> Shaping:
    shaping = Shaping()
    if take.measures_release:
        _staccato(ledger, take, shaping)
        _legato(ledger, take, shaping)
    if take.measures_dynamics:
        _accents(ledger, take, shaping)
        _hairpins(ledger, take, shaping)
    return shaping


def _phrases(items: list, beat_of) -> list[list]:
    """Split findings in timeline order wherever PHRASE_GAP_BEATS pass between them."""
    phrases: list[list] = []
    for item in sorted(items, key=beat_of):
        if phrases and beat_of(item) - beat_of(phrases[-1][-1]) <= PHRASE_GAP_BEATS:
            phrases[-1].append(item)
        else:
            phrases.append([item])
    return phrases


def _held_ms(notes: list[PerformanceEvent]) -> float | None:
    lengths = [note.tOffMs - note.tOnMs for note in notes if note.tOffMs > note.tOnMs]
    return statistics.median(lengths) if lengths else None


def _staccato(ledger: Ledger, take: Take, shaping: Shaping) -> None:
    held_long: list[tuple[ScoreOnset, ScoreEvent, int]] = []
    for onset, group, _ in take.matched:
        for member in onset.members:
            marks = set(member.articulations) & SHORT_MARKS
            notes = take.notes_in(group, member.pitches)
            if not marks or not notes:
                continue
            if any(note.pedalAtRelease for note in notes):
                shaping.pedalled += 1
                continue
            held = _held_ms(notes)
            if held is None:
                continue
            written = member.durationBeat * take.local_ms_per_beat(take.beat(onset))
            share = STACCATISSIMO_SHARE if "staccatissimo" in marks else STACCATO_SHARE
            shaping.staccato_checked += 1
            if held <= share * written:
                shaping.staccato_met += 1
            else:
                held_long.append((onset, member, round(100 * held / max(1.0, written))))
    for phrase in _phrases(held_long, lambda item: take.beat(item[0])):
        first, last = phrase[0][0], phrase[-1][0]
        pct = round(statistics.median(item[2] for item in phrase))
        evidence = ledger.add_evidence(
            first.measureNo, first.onsetBeat,
            msg("fact.staccatoHeld", **ledger.span(first.measureNo, last.measureNo),
                count=len(phrase), pct=pct),
            expected=msg("word.shortDetached"), actual=msg("word.heldPercent", pct=pct))
        ledger.add_error(
            ErrorType.duration_anomaly, first.measureNo, first.onsetBeat,
            [item[1].eventId for item in phrase], Severity.low, [evidence],
            msg("detail.staccato", **ledger.span(first.measureNo, last.measureNo)))


def _legato(ledger: Ledger, take: Take, shaping: Shaping) -> None:
    played = {onset.onsetId: group for onset, group, _ in take.matched}
    onset_of = {member.eventId: onset for onset in take.ordered for member in onset.members}
    by_part: dict[str, list[ScoreEvent]] = {}
    for onset in take.ordered:
        for member in onset.members:
            if not member.optional:
                by_part.setdefault(member.part, []).append(member)
    gaps: list[tuple[ScoreOnset, ScoreEvent, float]] = []
    for members in by_part.values():
        for current, following in zip(members, members[1:]):
            if not current.legatoToNext:
                continue
            here, there = onset_of[current.eventId], onset_of[following.eventId]
            group, next_group = played.get(here.onsetId), played.get(there.onsetId)
            if group is None or next_group is None:
                continue
            notes = take.notes_in(group, current.pitches)
            arrivals = [take.pitch_onsets[next_group.id][pitch] for pitch in following.pitches
                        if pitch in take.pitch_onsets[next_group.id]]
            releases = [note.tOffMs for note in notes if note.tOffMs > note.tOnMs]
            if not arrivals or not releases:
                continue
            if any(note.pedalAtRelease for note in notes):
                shaping.pedalled += 1
                continue
            started = min(take.pitch_onsets[group.id].get(pitch, group.tOnMs)
                          for pitch in current.pitches)
            arrival = min(arrivals)
            silence = arrival - max(releases)
            shaping.legato_checked += 1
            if silence <= max(LEGATO_GAP_MS, LEGATO_GAP_SHARE * (arrival - started)):
                shaping.legato_met += 1
            else:
                gaps.append((here, current, silence))
    for phrase in _phrases(gaps, lambda item: take.beat(item[0])):
        first, last = phrase[0][0], phrase[-1][0]
        widest = round(max(item[2] for item in phrase))
        evidence = ledger.add_evidence(
            first.measureNo, first.onsetBeat,
            msg("fact.legatoGaps", **ledger.span(first.measureNo, last.measureNo),
                count=len(phrase), ms=widest),
            expected=msg("word.joined"), actual=msg("word.gapMs", ms=widest),
            delta_ms=float(widest))
        ledger.add_error(
            ErrorType.duration_anomaly, first.measureNo, first.onsetBeat,
            [item[1].eventId for item in phrase], Severity.low, [evidence],
            msg("detail.legato", **ledger.span(first.measureNo, last.measureNo)))


def _velocity(take: Take, onset: ScoreOnset, group, part: str | None = None) -> float | None:
    pitches = [pitch for member in onset.members
               if part is None or member.part == part for pitch in member.pitches]
    values = [note.velocity for note in take.notes_in(group, pitches) if note.velocity > 0]
    return statistics.median(values) if values else None


def _accents(ledger: Ledger, take: Take, shaping: Shaping) -> None:
    accented = [(onset, group, member) for onset, group, _ in take.matched
                for member in onset.members
                if {"accent", "marcato"} & set(member.articulations)]
    accented_ids = {onset.onsetId for onset, _, _ in accented}
    weak: list[tuple[ScoreOnset, ScoreEvent, float, float]] = []
    for onset, group, member in accented:
        struck = _velocity(take, onset, group, member.part)
        beat = take.beat(onset)
        around = [value for other, other_group, _ in take.matched
                  if other.onsetId not in accented_ids
                  and abs(take.beat(other) - beat) <= ACCENT_NEIGHBOURHOOD
                  and (value := _velocity(take, other, other_group, member.part)) is not None]
        if struck is None or len(around) < 2:
            continue
        shaping.accents_checked += 1
        shaping.accented_onsets.add(onset.onsetId)
        surroundings = statistics.median(around)
        lift = MARCATO_LIFT if "marcato" in member.articulations else ACCENT_LIFT
        if struck - surroundings >= lift:
            shaping.accents_met += 1
        else:
            weak.append((onset, member, struck, surroundings))
    for phrase in _phrases(weak, lambda item: take.beat(item[0])):
        first, last = phrase[0][0], phrase[-1][0]
        struck = round(statistics.median(item[2] for item in phrase))
        around = round(statistics.median(item[3] for item in phrase))
        evidence = ledger.add_evidence(
            first.measureNo, first.onsetBeat,
            msg("fact.accentFlat", **ledger.span(first.measureNo, last.measureNo),
                count=len(phrase), accent=struck, around=around),
            expected=msg("word.louderThanAround"),
            actual=f"MIDI velocity {struck} / {around}",
            delta_velocity=float(struck - around))
        ledger.add_error(
            ErrorType.dynamics_anomaly, first.measureNo, first.onsetBeat,
            [item[1].eventId for item in phrase], Severity.low, [evidence],
            msg("detail.accent", **ledger.span(first.measureNo, last.measureNo)))


def _hairpins(ledger: Ledger, take: Take, shaping: Shaping) -> None:
    for hairpin in take.written.hairpins:
        inside = [(onset, value) for onset, group, _ in take.matched
                  # The notes struck under the hairpin; the one after it ends
                  # is where it arrives, not part of the growth.
                  if hairpin.startBeat - 1e-6 <= take.beat(onset) < hairpin.endBeat - 1e-6
                  and (value := _velocity(take, onset, group)) is not None]
        if len(inside) < 3:
            continue
        third = max(1, len(inside) // 3)
        opening = statistics.mean(value for _, value in inside[:third])
        closing = statistics.mean(value for _, value in inside[-third:])
        change = closing - opening
        shaping.hairpins_checked += 1
        growing = hairpin.kind == "crescendo"
        if (change >= HAIRPIN_CHANGE) if growing else (change <= -HAIRPIN_CHANGE):
            shaping.hairpins_met += 1
            continue
        first, last = inside[0][0], inside[-1][0]
        kind = msg("word.crescendo" if growing else "word.diminuendo")
        evidence = ledger.add_evidence(
            first.measureNo, first.onsetBeat,
            msg("fact.hairpin", kind=kind, **ledger.span(first.measureNo, last.measureNo),
                **{"from": f"{opening:.0f}"}, to=f"{closing:.0f}"),
            expected=msg("word.hairpinExpected" if growing else "word.hairpinExpectedDown",
                         amount=f"{HAIRPIN_CHANGE:.0f}"),
            actual=f"MIDI velocity {opening:.0f} → {closing:.0f}",
            delta_velocity=round(change, 1))
        ledger.add_error(
            ErrorType.dynamics_anomaly, first.measureNo, first.onsetBeat,
            [member.eventId for onset, _ in inside for member in onset.members],
            Severity.medium, [evidence],
            msg("detail.hairpin", kind=kind, **ledger.span(first.measureNo, last.measureNo)))
