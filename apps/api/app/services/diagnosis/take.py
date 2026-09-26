"""One aligned take, and what the page asked of it.

Every diagnosis rule reads the same two things: what was played, lined up
against the score, and what the notation asks for at that point — the written
tempo, a fermata, a slur. They used to be threaded through as a dozen loose
arguments, and each new rule meant another. They live here once.
"""
from __future__ import annotations

import statistics
from bisect import bisect_right
from dataclasses import dataclass, field
from functools import cached_property

from app.schemas.models import (AlignmentPair, AlignOp, Hairpin,
                                PerformanceEvent, PerformanceGroup, ScoreMeta,
                                TempoSpan)
from app.services.alignment.onset import ScoreOnset, score_onset_beat
from app.services.alignment.tempo import TempoMap

SHORT_MARKS = {"staccato", "staccatissimo"}


@dataclass(frozen=True)
class Restart:
    """A passage begun, abandoned, and begun again.

    ``abandoned`` are the played notes of the first attempt (and any fumbled
    notes after it); they are set aside before alignment, so the attempt that
    carried on is the one matched to the score.
    """
    abandoned: tuple[str, ...]
    #: The first note of the attempt that carried on: where the player went back to.
    resumed_at: str
    #: How many notes the abandoned attempt reached before stopping.
    reached: int


class Written:
    """What the notation asks for, looked up by timeline beat."""

    def __init__(self, meta: ScoreMeta, onsets: list[ScoreOnset]):
        self.plan: list[TempoSpan] = (sorted(meta.tempoPlan, key=lambda span: span.startBeat)
                                      or [TempoSpan(startBeat=0.0, bpm=meta.tempo)])
        self._starts = [span.startBeat for span in self.plan]
        self.hairpins: list[Hairpin] = list(meta.hairpins)
        self.nominal_bpm = meta.tempo
        # A fermata lets the note under it last as long as the player likes, so
        # the gap after it is the player's to choose.
        self.fermata_onsets = {onset.onsetId for onset in onsets
                               if any("fermata" in member.articulations
                                      for member in onset.members)}

    def span_at(self, beat: float) -> TempoSpan:
        return self.plan[max(0, bisect_right(self._starts, beat + 1e-9) - 1)]

    def bpm_at(self, beat: float) -> float:
        return self.span_at(beat).bpm

    def free_between(self, start: float, end: float) -> bool:
        """Whether the page lets the tempo move anywhere in [start, end]."""
        return any(span.shape != "steady" and span.startBeat <= end and
                   (index + 1 >= len(self.plan) or self.plan[index + 1].startBeat > start)
                   for index, span in enumerate(self.plan))

    def mean_bpm(self, start: float, end: float) -> float:
        """The written tempo averaged over [start, end], weighted by beats."""
        if end <= start:
            return self.bpm_at(start)
        total = 0.0
        for index, span in enumerate(self.plan):
            span_end = self.plan[index + 1].startBeat if index + 1 < len(self.plan) else end
            overlap = min(end, span_end) - max(start, span.startBeat)
            if overlap > 0:
                total += overlap * span.bpm
        return total / (end - start) if total else self.bpm_at(start)

    def steady_around(self, beat: float, radius: float) -> bool:
        """One steady written tempo holds across [beat − radius, beat + radius].

        A reading averaged over a window that straddles a written change is
        half one tempo and half the other, and belongs to neither.
        """
        first, last = self.span_at(beat - radius), self.span_at(beat + radius)
        return first is last and first.shape == "steady"

    @property
    def changes_tempo(self) -> bool:
        return len({span.bpm for span in self.plan}) > 1 or any(
            span.shape != "steady" for span in self.plan)


@dataclass
class Take:
    pairs: list[AlignmentPair]
    onsets: dict[str, ScoreOnset]
    groups: dict[str, PerformanceGroup]
    tempo_map: TempoMap
    beats_per_measure: float
    bpm: float
    notes: dict[str, PerformanceEvent]
    written: Written
    # A MIDI velocity is a measurement of how hard a key was struck; a
    # microphone amplitude is not, and must never be graded as one.
    measures_dynamics: bool = True
    # A key release is only a release when a keyboard reports it. A microphone
    # hears a note fade, which is the piano's decay, not the player's hand.
    measures_release: bool = True
    measure_labels: list[str] = field(default_factory=list)
    #: Passages abandoned and begun again, found before alignment.
    restarts: list[Restart] = field(default_factory=list)

    def beat(self, onset: ScoreOnset) -> float:
        return score_onset_beat(onset, self.beats_per_measure)

    @property
    def beat_ms(self) -> float:
        return 60_000.0 / self.bpm

    @cached_property
    def ordered(self) -> list[ScoreOnset]:
        return sorted(self.onsets.values(), key=self.beat)

    @cached_property
    def matched(self) -> list[tuple[ScoreOnset, PerformanceGroup, AlignmentPair]]:
        """Every score onset something was played at, in timeline order."""
        found = []
        for pair in self.pairs:
            if pair.operation not in (AlignOp.match, AlignOp.substitute):
                continue
            onset = self.onsets.get(pair.scoreEventId or "")
            group = self.groups.get(pair.performanceId or "")
            if onset and group:
                found.append((onset, group, pair))
        return sorted(found, key=lambda item: self.beat(item[0]))

    @cached_property
    def pitch_onsets(self) -> dict[str, dict[int, float]]:
        """For each played group, when each of its pitches was first struck."""
        found: dict[str, dict[int, float]] = {}
        for group in self.groups.values():
            onsets: dict[int, float] = {}
            for event_id in group.eventIds:
                note = self.notes.get(event_id)
                if note and (note.pitch not in onsets or note.tOnMs < onsets[note.pitch]):
                    onsets[note.pitch] = note.tOnMs
            found[group.id] = onsets
        return found

    def played_without_stops(self, stops: dict[str, float]
                             ) -> list[tuple[float, float, ScoreOnset]]:
        """(beat, ms, onset) for every matched onset, with each stop cut out.

        ``stops`` maps the onset after a stop to how long the stop ran. Every
        onset from there on is moved earlier by it, so tempo is measured on
        the music as played and a stop — already named once — does not show up
        a second time as the tempo sagging around it.
        """
        cut = 0.0
        points = []
        for onset, group, _ in self.matched:
            cut += stops.get(onset.onsetId, 0.0)
            points.append((self.beat(onset), group.tOnMs - cut, onset))
        return points

    def notes_in(self, group: PerformanceGroup, pitches) -> list[PerformanceEvent]:
        """The played notes of one group that sound these pitches."""
        wanted = set(pitches)
        return [note for event_id in group.eventIds
                if (note := self.notes.get(event_id)) and note.pitch in wanted]

    def local_ms_per_beat(self, beat: float, exclude: tuple[float, float] | None = None,
                          radius: float = 4.0) -> float:
        """The player's own pulse around a beat, from the notes either side.

        A median of the intervals between neighbouring matched onsets, so one
        late note or one pause does not move it. ``exclude`` leaves out the
        interval being judged, so a pause is never measured against itself.
        """
        spans = []
        points = [(self.beat(onset), group.tOnMs) for onset, group, _ in self.matched]
        for (b0, t0), (b1, t1) in zip(points, points[1:]):
            if b1 <= b0 or t1 <= t0 or (exclude and abs(b0 - exclude[0]) < 1e-9
                                         and abs(b1 - exclude[1]) < 1e-9):
                continue
            if abs((b0 + b1) / 2 - beat) <= radius:
                spans.append((t1 - t0) / (b1 - b0))
        if len(spans) >= 2:
            return statistics.median(spans)
        every = [(t1 - t0) / (b1 - b0) for (b0, t0), (b1, t1) in zip(points, points[1:])
                 if b1 > b0 and t1 > t0]
        return statistics.median(every) if every else self.beat_ms
