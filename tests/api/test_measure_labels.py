"""The number a bar is called on the page, versus its place in the timeline.

`measureNo` counts 1, 2, 3… because alignment and event IDs need a position.
What the page prints can differ, and the app has to say the printed number or it
sends the student to the wrong bar.
"""
from __future__ import annotations

import music21

from app.services.score_import import measure_labels, parse_musicxml


def _score(numbers: list[int | None], notes_per_bar: int = 1) -> music21.stream.Score:
    score = music21.stream.Score()
    part = music21.stream.Part()
    part.append(music21.clef.TrebleClef())
    part.append(music21.meter.TimeSignature("4/4"))
    for number in numbers:
        measure = (music21.stream.Measure() if number is None
                   else music21.stream.Measure(number=number))
        for _ in range(notes_per_bar):
            measure.append(music21.note.Note("C4", quarterLength=4 / notes_per_bar))
        part.append(measure)
    score.insert(0, part)
    return score


def test_a_plainly_numbered_score_keeps_its_own_numbers():
    assert measure_labels(_score([1, 2, 3, 4])) == ["1", "2", "3", "4"]


def test_a_pickup_bar_stays_bar_zero():
    # This is the case that used to report every bar one too high: the pickup
    # takes timeline position 1, but the page calls it 0.
    assert measure_labels(_score([0, 1, 2, 3])) == ["0", "1", "2", "3"]


def test_a_file_that_numbers_every_bar_zero_is_renumbered():
    # music21 gives a hand-built Measure the number 0. A page printing "0" over
    # every system contradicts every position the app reports.
    assert measure_labels(_score([0, 0, 0])) == ["1", "2", "3"]


def test_unnumbered_bars_are_renumbered():
    assert measure_labels(_score([None, None])) == ["1", "2"]


def test_a_lone_unnumbered_bar_is_called_one_not_zero():
    # music21 reports an unnumbered bar and a bar printed "0" identically, so a
    # single bar numbered 0 has to be read as "never numbered".
    assert measure_labels(_score([None])) == ["1"]


def test_numbers_that_go_backwards_are_not_trusted():
    assert measure_labels(_score([1, 5, 2])) == ["1", "2", "3"]


def test_repeated_numbers_are_not_trusted():
    assert measure_labels(_score([1, 1, 2])) == ["1", "2", "3"]


def test_a_score_without_parts_has_no_labels():
    assert measure_labels(music21.stream.Score()) == []


def test_the_labels_reach_the_bundle_a_client_reads():
    xml = music21.musicxml.m21ToXml.GeneralObjectExporter().parse(
        _score([0, 1, 2]))
    bundle = parse_musicxml(xml, "anacrusis")
    assert bundle.meta.measureLabels == ["0", "1", "2"]
    # The timeline is untouched: the pickup is still position 1.
    assert min(event.measureNo for event in bundle.events) == 1
