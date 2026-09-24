"""Where the music stopped when the page did not.

Two things a teacher hears first and a note-by-note check never names:

- **A pause.** The player stops before a hard bar and starts again. The tempo
  map absorbs the jump — it has to, or every later note would read as late —
  and so the pause itself used to vanish from the report entirely.
- **Going back.** The player fumbles, returns a few notes and plays them again.
  The second pass has nowhere to go in the score, so each of its notes used to
  be reported as an extra note: one self-correction, five mistakes. It is
  found in the played notes before alignment, because once aligned there is
  no telling which of two identical passes was "the" one.

Both are one event, and each is reported once, at the note where it happened.
"""
from __future__ import annotations

import statistics

from app.i18n import msg
from app.schemas.models import ErrorType, PerformanceEvent, Severity
from app.services.alignment.grouping import group_chord_onsets
from app.services.alignment.onset import ScoreOnset
from app.services.alignment.tempo import stop_excess
from app.services.diagnosis.ledger import Ledger
from app.services.diagnosis.take import Restart, Take

#: The fewest notes that make a doubled run recognisable as a restart. Two
#: would catch every repeated pair of notes a melody is made of.
MIN_REPLAY_NOTES = 3
#: The longest run looked for; a player going back further is starting over.
MAX_REPLAY_NOTES_SCAN = 16
#: Stray notes allowed between giving up and starting again.
MAX_FUMBLES = 2
#: Notes this close are one chord when looking for a restart: wide enough for
#: hands that land a little apart, narrow enough to keep a melody's notes apart.
RESTART_CHORD_WINDOW_MS = 160.0
#: How much longer than the passage's pace the gap before going back must be.
RESTART_HICCUP = 1.25


def find_pauses(ledger: Ledger, take: Take,
                explained: dict[str, float] | set[str] = frozenset()) -> dict[str, float]:
    """Report every unwritten stop; return each onset after one, with its length in ms.

    A stop is what ``stop_excess`` says it is — the same definition the tempo
    fit used to keep it out of the timing of the notes around it.
    ``explained`` are onsets whose gap something else already accounts for:
    the place a restart went back to.
    """
    matched = take.matched
    after_pause: dict[str, float] = {}
    for index, ((before, first, _), (onset, group, _)) in enumerate(zip(matched, matched[1:])):
        b0, b1 = take.beat(before), take.beat(onset)
        gap_ms = group.tOnMs - first.tOnMs
        if (b1 <= b0 or gap_ms <= 0 or before.onsetId in take.written.fermata_onsets
                or onset.onsetId in explained):
            continue
        pulse = take.local_ms_per_beat((b0 + b1) / 2, exclude=(b0, b1))
        following = matched[index + 2] if index + 2 < len(matched) else None
        next_ms_per_beat = None
        if following is not None and take.beat(following[0]) > b1:
            next_ms_per_beat = ((following[1].tOnMs - group.tOnMs)
                                / (take.beat(following[0]) - b1))
        excess = stop_excess(gap_ms, b1 - b0, pulse, next_ms_per_beat,
                             leeway=1.5 if take.written.free_between(b0, b1) else 1.0)
        if excess <= 0:
            continue
        seconds = f"{excess / 1000:.1f}"
        evidence = ledger.add_evidence(
            onset.measureNo, onset.onsetBeat,
            msg("fact.pause", **ledger.at(onset), seconds=seconds,
                beats=f"{excess / pulse:.1f}"),
            expected=msg("word.noStop"), actual=msg("word.stoppedFor", seconds=seconds),
            delta_ms=round(excess, 1))
        ledger.add_error(
            ErrorType.hesitation, onset.measureNo, onset.onsetBeat,
            [member.eventId for member in onset.members],
            Severity.high if excess >= 2 * pulse else Severity.medium,
            [evidence], msg("detail.pause", **ledger.at(onset), seconds=seconds))
        after_pause[onset.onsetId] = excess
    return after_pause


def find_restarts(events: list[PerformanceEvent], onsets: list[ScoreOnset]) -> list[Restart]:
    """Find passages played twice in a row that the page writes only once.

    A restart leaves the same run of notes twice in the played sequence: the
    attempt, a stumble or a stop, then the same notes again. The page is the
    arbiter — a figure the score itself repeats is music, not a restart — so a
    doubled run counts only when the score has the run but does not repeat it
    within a few notes.

    Read on chords gathered a little more loosely than alignment gathers them,
    so a left hand landing just after the right is still one chord, and an
    attempt that played only part of a chord still counts as playing it.
    """
    groups = group_chord_onsets(events, window_ms=RESTART_CHORD_WINDOW_MS)
    played = [frozenset(group.pitches) for group in groups]
    times = [group.tOnMs for group in groups]
    written = [frozenset(onset.pitches) for onset in onsets]
    restarts: list[Restart] = []
    taken: set[int] = set()
    start = 0
    while start < len(played):
        found = _doubled_run(played, times, written, start, taken)
        if found is None:
            start += 1
            continue
        attempt, again, length = found
        abandoned = tuple(event_id for group in groups[attempt:again]
                          for event_id in group.eventIds)
        restarts.append(Restart(abandoned=abandoned, resumed_at=groups[again].eventIds[0],
                                reached=min(length, again - attempt)))
        taken.update(range(attempt, again + length))
        start = again + length
    return restarts


def _part_of(part: frozenset[int], whole: frozenset[int]) -> bool:
    """`part` is `whole`, or at least half of it — one hand of a two-hand chord.

    A single note is part of every chord that contains it, so a smaller share
    would let one stray note stand in for any chord at all.
    """
    return bool(part) and part <= whole and 2 * len(part) >= len(whole)


def _same(first: frozenset[int], second: frozenset[int]) -> bool:
    """One chord, or one of them most of the other."""
    return _part_of(first, second) or _part_of(second, first)


def _doubled_run(played: list[frozenset[int]], times: list[float],
                 written: list[frozenset[int]],
                 attempt: int, taken: set[int]) -> tuple[int, int, int] | None:
    """(attempt, restart, length) for a run starting at `attempt` played twice."""
    for fumbles in range(0, MAX_FUMBLES + 1):
        for length in range(MAX_REPLAY_NOTES_SCAN, MIN_REPLAY_NOTES - 1, -1):
            again = attempt + length + fumbles
            if again + length > len(played) or any(
                    index in taken for index in range(attempt, again + length)):
                continue
            if not all(_same(played[attempt + offset], played[again + offset])
                       for offset in range(length)):
                continue
            # Going back is preceded by a hiccup: the gap before the second
            # attempt is longer than the passage's own pace. Without one, the
            # same notes twice are more likely the music than a restart.
            pace = statistics.median(
                later - earlier for earlier, later in zip(times[again:again + length],
                                                          times[again + 1:again + length]))
            if times[again] - times[again - 1] < RESTART_HICCUP * pace:
                continue
            places = _places(played[again:again + length], written)
            if places and not _written_twice(places, length):
                return attempt, again, length
    return None


def _places(run: list[frozenset[int]], written: list[frozenset[int]]) -> list[int]:
    """Every position where the score has this run, chord by chord."""
    size = len(run)
    return [start for start in range(len(written) - size + 1)
            if all(_part_of(chord, written[start + offset])
                   for offset, chord in enumerate(run))]


def _written_twice(places: list[int], length: int) -> bool:
    """The score itself plays this figure again within a few notes.

    What lies between the two copies does not matter: the notes a player
    stumbles on there can be anything, and a figure the page repeats is music
    whatever was fumbled between.
    """
    return any(0 <= later - (earlier + length) <= MAX_FUMBLES
               for earlier in places for later in places if later > earlier)


def report_restarts(ledger: Ledger, take: Take, restarts: list[Restart]) -> dict[str, float]:
    """Name each restart at the note where the first attempt gave out.

    Returns each onset a restart went back to, with the time the abandoned
    attempt took, so that gap is not reported again as a pause and is cut out
    before tempo is measured.
    """
    placed = {event_id: onset for onset, group, _ in take.matched
              for event_id in group.eventIds}
    position = {onset.onsetId: index for index, onset in enumerate(take.ordered)}
    before = {onset.onsetId: (previous, previous_group)
              for (previous, previous_group, _), (onset, _, _) in zip(take.matched, take.matched[1:])}
    arrival = {onset.onsetId: group.tOnMs for onset, group, _ in take.matched}
    explained: dict[str, float] = {}
    for restart in restarts:
        went_back_to = placed.get(restart.resumed_at)
        if went_back_to is None:
            continue
        index = position[went_back_to.onsetId]
        broke_off = take.ordered[min(len(take.ordered) - 1, index + restart.reached)]
        back = ledger.label(went_back_to.measureNo)
        evidence = ledger.add_evidence(
            broke_off.measureNo, broke_off.onsetBeat,
            msg("fact.replay", **ledger.at(broke_off), back=back,
                count=len(restart.abandoned)),
            expected=msg("word.noStop"), actual=msg("word.wentBackTo", bar=back))
        ledger.add_error(
            ErrorType.hesitation, broke_off.measureNo, broke_off.onsetBeat,
            [member.eventId for member in broke_off.members], Severity.medium,
            [evidence], msg("detail.replay", **ledger.at(broke_off), back=back))
        gap = 0.0
        if went_back_to.onsetId in before:
            previous, previous_group = before[went_back_to.onsetId]
            beats = take.beat(went_back_to) - take.beat(previous)
            pulse = take.local_ms_per_beat(take.beat(went_back_to))
            gap = max(0.0, arrival[went_back_to.onsetId] - previous_group.tOnMs - beats * pulse)
        explained[went_back_to.onsetId] = gap
    return explained
