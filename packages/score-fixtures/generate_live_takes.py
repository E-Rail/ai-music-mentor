"""Sample MIDI takes for trying out the live layer by hand.

These are not the analyser's controlled test set — that is `generate_fixtures.py`
and it stays as it is. These are four short performances of 小星星 bars 1–4,
each one aimed at a single thing the live layer has to get right:

    correct              both hands, exactly as written
    hands-apart          the left hand lands 260 ms after the right, every time
    wrong-note-fixed     one wrong note in bar 2, then the player corrects it
    wrong-note-held      the same wrong note, never corrected

The notes come from the app's own importer reading the demo score, so a sample
can never drift away from the page it is meant to match.

Run:  .venv/bin/python packages/score-fixtures/generate_live_takes.py
Play: node apps/web/scripts/play-midi-take.mjs <file>
"""
from __future__ import annotations

import sys
from pathlib import Path

import mido

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.services.score_import import parse_musicxml  # noqa: E402

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "scores" / "twinkle_star.musicxml"
OUT = HERE / "midi" / "live"

BPM = 92
TICKS_PER_BEAT = 480
THROUGH_MEASURE = 4
VELOCITY = 80
# A quarter note is held most of its length; the gap is what makes a repeated
# note read as two notes rather than one long one.
GATE = 0.85


def written_notes(through_measure: int) -> list[dict]:
    """Every note the page prints in the opening bars, as (beat, pitch, hand)."""
    bundle = parse_musicxml(SOURCE.read_bytes(), score_id="twinkle_star")
    notes: list[dict] = []
    for event in bundle.events:
        if event.measureNo > through_measure:
            continue
        beat = event.absoluteBeat
        if beat is None:
            beat = (event.measureNo - 1) * 4 + event.onsetBeat
        hand = "left" if ":LH:" in event.eventId else "right"
        for pitch in event.pitches:
            notes.append({
                "beat": float(beat),
                "pitch": int(pitch),
                "beats": float(event.durationBeat),
                "hand": hand,
            })
    return sorted(notes, key=lambda note: (note["beat"], note["pitch"]))


def write_take(name: str, notes: list[dict], purpose: str) -> Path:
    """One track, absolute beats in, delta ticks out."""
    ordered = sorted(notes, key=lambda note: (note["beat"], note["pitch"]))
    events: list[tuple[float, int, int]] = []
    for note in ordered:
        on = note["beat"]
        off = on + max(note["beats"] * GATE, 0.1)
        events.append((on, note["pitch"], VELOCITY))
        events.append((off, note["pitch"], 0))
    events.sort(key=lambda item: (item[0], item[2]))

    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=purpose, time=0))
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(BPM), time=0))
    previous = 0.0
    for beat, pitch, velocity in events:
        delta = int(round((beat - previous) * TICKS_PER_BEAT))
        previous = beat
        track.append(mido.Message(
            "note_on", note=pitch, velocity=velocity, time=max(delta, 0)))

    midi = mido.MidiFile(ticks_per_beat=TICKS_PER_BEAT)
    midi.tracks.append(track)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.mid"
    midi.save(str(path))
    return path


def main() -> None:
    written = written_notes(THROUGH_MEASURE)

    # 1. Exactly what is on the page, both hands together.
    correct = [dict(note) for note in written]

    # 2. The same notes, but the left hand is late every time — by more than a
    #    chord window, and in the worst take by most of the bar it belongs to.
    #    The page holds each of these left-hand notes for four beats, so a hand
    #    this late is still playing the note it owes.
    def left_hand_late(beats: float) -> list[dict]:
        take = []
        for note in written:
            moved = dict(note)
            if note["hand"] == "left":
                moved["beat"] = note["beat"] + beats
            take.append(moved)
        return take

    apart = left_hand_late(0.4)          # ≈ 260 ms at 92 BPM
    struggling = left_hand_late(2.5)     # most of the bar behind

    # 3. Bar 2 beat 1 is written A4. Play B♭4 instead, then correct it.
    def with_wrong_note(fix: bool) -> list[dict]:
        take = []
        for note in written:
            if note["beat"] == 4.0 and note["pitch"] == 69:
                take.append({**note, "pitch": 70, "beats": 0.45})
                if fix:
                    take.append({**note, "beat": 4.5, "beats": 0.45})
                continue
            take.append(dict(note))
        return take

    # A MIDI track name is Latin-1 on the wire, so these stay in ASCII.
    made = [
        write_take("twinkle-correct", correct,
                   "Twinkle 1-4: both hands, as written"),
        write_take("twinkle-hands-apart", apart,
                   "Twinkle 1-4: left hand lands 260ms after the right"),
        write_take("twinkle-left-hand-struggling", struggling,
                   "Twinkle 1-4: left hand lands most of a bar late"),
        write_take("twinkle-wrong-note-fixed", with_wrong_note(fix=True),
                   "Twinkle 1-4: Bb4 for A4 in bar 2, then corrected"),
        write_take("twinkle-wrong-note-held", with_wrong_note(fix=False),
                   "Twinkle 1-4: Bb4 for A4 in bar 2, never corrected"),
    ]
    for path in made:
        print(f"  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
