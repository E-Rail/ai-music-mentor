"""What the app does with a reading of a photographed page.

The model's answer is untrusted input. These tests pin the deterministic half:
what survives, what is dropped and reported, and what the student ends up
practising against.
"""
from __future__ import annotations

import pytest

from app.services.importers.vision import (VisionScoreImporter,
                                           read_page_to_events)
from app.services.vision import ReadPage


def _page(**overrides) -> ReadPage:
    base = {
        "title": "小星星",
        "timeSignature": "4/4",
        "tempo": 92,
        "measures": [
            {"number": 1, "notes": [
                {"staff": "RH", "step": "C", "octave": 4, "onset": 0, "duration": 1},
                {"staff": "RH", "step": "C", "octave": 4, "onset": 1, "duration": 1},
                {"staff": "RH", "step": "G", "octave": 4, "onset": 2, "duration": 1},
                {"staff": "RH", "step": "G", "octave": 4, "onset": 3, "duration": 1},
                {"staff": "LH", "step": "C", "octave": 3, "onset": 0, "duration": 4},
            ]},
            {"number": 2, "notes": [
                {"staff": "RH", "step": "A", "octave": 4, "onset": 0, "duration": 1},
                {"staff": "RH", "step": "A", "octave": 4, "onset": 1, "duration": 1},
                {"staff": "RH", "step": "G", "octave": 4, "onset": 2, "duration": 2},
                {"staff": "LH", "step": "F", "octave": 3, "onset": 0, "duration": 4},
            ]},
        ],
        "confidence": 0.72,
    }
    base.update(overrides)
    return ReadPage.model_validate(base)


def test_a_clean_reading_becomes_the_notes_that_were_printed():
    events, notices = read_page_to_events(_page(), "s1", 4.0)
    assert not notices
    right = [event for event in events if event.part == "RH"]
    assert [event.pitches for event in right] == [[60], [60], [67], [67], [69], [69], [67]]
    assert [event.measureNo for event in right] == [1, 1, 1, 1, 2, 2, 2]
    left = [event for event in events if event.part == "LH"]
    assert [event.pitches for event in left] == [[48], [53]]
    assert left[0].durationBeat == 4.0


def test_simultaneous_notes_on_one_staff_become_one_chord():
    page = _page(measures=[{"number": 1, "notes": [
        {"staff": "RH", "step": "C", "octave": 4, "onset": 0, "duration": 4},
        {"staff": "RH", "step": "E", "octave": 4, "onset": 0, "duration": 4},
        {"staff": "RH", "step": "G", "octave": 4, "onset": 0, "duration": 4},
    ]}])
    events, _ = read_page_to_events(page, "s1", 4.0)
    assert [event.pitches for event in events] == [[60, 64, 67]]


def test_an_accidental_moves_the_pitch():
    page = _page(measures=[{"number": 1, "notes": [
        {"staff": "RH", "step": "B", "alter": -1, "octave": 4, "onset": 0, "duration": 4},
    ]}])
    events, _ = read_page_to_events(page, "s1", 4.0)
    assert events[0].pitches == [70]


def test_a_note_past_the_end_of_its_bar_is_dropped_and_reported():
    page = _page(measures=[{"number": 1, "notes": [
        {"staff": "RH", "step": "C", "octave": 4, "onset": 0, "duration": 1},
        {"staff": "RH", "step": "D", "octave": 4, "onset": 6, "duration": 1},
    ]}])
    events, notices = read_page_to_events(page, "s1", 4.0)
    assert [event.pitches for event in events] == [[60]]
    assert any("超出所在小节" in notice for notice in notices)


def test_a_note_that_overruns_the_barline_is_cut_at_it():
    page = _page(measures=[{"number": 1, "notes": [
        {"staff": "RH", "step": "C", "octave": 4, "onset": 3, "duration": 4},
    ]}])
    events, _ = read_page_to_events(page, "s1", 4.0)
    assert events[0].durationBeat == 1.0


def test_a_pickup_bar_keeps_its_printed_number_but_takes_position_one():
    page = _page(measures=[
        {"number": 0, "notes": [
            {"staff": "RH", "step": "G", "octave": 4, "onset": 3, "duration": 1}]},
        {"number": 1, "notes": [
            {"staff": "RH", "step": "C", "octave": 4, "onset": 0, "duration": 4}]},
    ])
    events, _ = read_page_to_events(page, "s1", 4.0)
    assert [event.measureNo for event in events] == [1, 2]
    assert [event.pitches for event in events] == [[67], [60]]


def test_an_empty_bar_is_reported_rather_than_silently_padded():
    page = _page(measures=[
        {"number": 1, "notes": []},
        {"number": 2, "notes": [
            {"staff": "RH", "step": "C", "octave": 4, "onset": 0, "duration": 4}]},
    ])
    events, notices = read_page_to_events(page, "s1", 4.0)
    assert len(events) == 1
    assert any("没有识别出音符" in notice for notice in notices)


def test_a_meter_the_app_cannot_engrave_is_refused_at_the_boundary():
    with pytest.raises(ValueError):
        ReadPage.model_validate({"timeSignature": "4/5", "measures": []})


def test_the_staff_name_is_normalised_rather_than_trusted():
    page = _page(measures=[{"number": 1, "notes": [
        {"staff": "left", "step": "C", "octave": 3, "onset": 0, "duration": 4},
        {"staff": "treble", "step": "C", "octave": 5, "onset": 0, "duration": 4},
    ]}])
    events, _ = read_page_to_events(page, "s1", 4.0)
    assert {event.part for event in events} == {"LH", "RH"}


def test_a_note_is_read_from_the_way_a_musician_writes_one():
    page = ReadPage.model_validate({"measures": [
        {"number": 1, "notes": ["RH C4 0 1", "LH Bb2 0 4", "RH F#5 1.5 0.5"]}]})
    notes = page.measures[0].notes
    assert [(note.staff, note.step, note.alter, note.octave) for note in notes] == [
        ("RH", "C", 0, 4), ("LH", "B", -1, 2), ("RH", "F", 1, 5)]
    assert [(note.onset, note.duration) for note in notes] == [
        (0.0, 1.0), (0.0, 4.0), (1.5, 0.5)]


def test_a_reading_that_names_its_fields_differently_is_still_read():
    # Models reach for `bars` and `bar_number` regardless of what they are asked
    # for. Rejecting a correct transcription over that would waste a minute of
    # someone's time to make a point.
    page = ReadPage.model_validate({
        "time_signature": "3/4",
        "bars": [{"bar_number": 4, "notes": [
            {"pitch": "G4", "onset": 0, "duration": 3, "staff": "RH"}]}],
    })
    assert page.timeSignature == "3/4"
    assert page.measures[0].number == 4
    assert page.measures[0].notes[0].step == "G"
    assert page.measures[0].notes[0].octave == 4


def test_a_bar_written_as_one_staff_keeps_that_staff_on_its_notes():
    page = ReadPage.model_validate({"measures": [
        {"number": 1, "staff": "LH", "notes": ["C3 0 4"]}]})
    assert page.measures[0].notes[0].staff == "LH"
    assert page.measures[0].notes[0].octave == 3


def test_common_time_is_understood_as_a_meter():
    assert ReadPage.model_validate({"timeSignature": "C"}).timeSignature == "4/4"


def test_a_note_that_is_not_a_note_is_refused():
    with pytest.raises(ValueError):
        ReadPage.model_validate({"measures": [{"number": 1, "notes": ["RH loud 0 1"]}]})


@pytest.mark.parametrize("filename,content,expected", [
    ("page.pdf", b"%PDF-1.4 rest", True),
    ("photo.jpg", b"\xff\xd8\xff\xe0 rest", True),
    ("photo.PNG", b"\x89PNG\r\n\x1a\n rest", True),
    ("noname", b"\x89PNG\r\n\x1a\n rest", True),
    ("score.musicxml", b"<score-partwise/>", False),
    ("take.mid", b"MThd", False),
])
def test_which_files_the_page_reader_claims(filename, content, expected):
    assert VisionScoreImporter().supports(filename, content) is expected
