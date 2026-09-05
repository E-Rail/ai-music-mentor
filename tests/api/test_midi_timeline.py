"""A MIDI import must lay its notes out on the score's own timeline.

build_onsets sorts the whole score by absoluteBeat, so that field is the
timeline, not a decoration. Handing it a measure-relative offset reorders a
multi-measure piece beat-major across bars and collapses every bar onto the
first one's expected times — which makes the diagnosis of any MIDI-imported
piece longer than one bar meaningless.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.services.alignment.onset import build_onsets, score_onset_beat  # noqa: E402
from app.services.importers.midi import MidiScoreImporter  # noqa: E402

BEATS = 4
BARS = 3


def _three_bars_of_crotchets() -> bytes:
    """One note per beat for three 4/4 bars, ascending so order is visible."""
    midi = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500_000, time=0))
    track.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    for index in range(BARS * BEATS):
        track.append(mido.Message("note_on", note=60 + index, velocity=80, time=0))
        track.append(mido.Message("note_off", note=60 + index, velocity=0, time=480))
    buffer = io.BytesIO()
    midi.save(file=buffer)
    return buffer.getvalue()


def _imported_onsets():
    result = MidiScoreImporter().import_bytes(
        "three-bars.mid", _three_bars_of_crotchets(), "timeline-test")
    return build_onsets(result.normalized.bundle.events)


def test_onsets_stay_in_playing_order_across_bars():
    onsets = _imported_onsets()
    positions = [(o.measureNo, o.onsetBeat) for o in onsets]
    assert positions == sorted(positions), (
        f"the score is not in playing order: {positions}")
    # The specific failure this guards: every bar's beat 1, then every bar's
    # beat 2, rather than bar 1 followed by bar 2.
    assert [m for m, _ in positions] == sorted(m for m, _ in positions)


def test_the_timeline_beat_advances_across_bars():
    beats = [score_onset_beat(o, BEATS) for o in _imported_onsets()]
    assert beats == sorted(beats)
    assert beats == [float(i) for i in range(BARS * BEATS)], (
        f"bars are collapsed onto one another: {beats}")


def test_the_last_note_is_expected_where_it_is_actually_played():
    onsets = _imported_onsets()
    last = score_onset_beat(onsets[-1], BEATS)
    # Three bars of crotchets at 120bpm: the last note falls on beat 11, 5.5s in.
    assert last == 11.0
    assert last * 500 == 5_500
