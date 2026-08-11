"""Well-known public-domain demo songs.

Every melody below is written as 简谱 (numbered notation, 1=C) in the comment
above it so a teacher can check the tune by reading, without playing it back.
Right hand carries the melody; the left hand is a sparse whole-note bass that
keeps both staves in the demo without making the piece hard to play or hard for
the microphone to follow.

Public domain, all of them:
  小星星   Ah! vous dirai-je, maman (French, 1761)
  欢乐颂   Beethoven, Symphony No. 9 (1824)
  两只老虎 Frère Jacques (French traditional)
  茉莉花   Jiangsu folk song (traditional)

Run: .venv/bin/python packages/score-fixtures/generate_demo_songs.py
"""
from __future__ import annotations

import json
from pathlib import Path

import music21

OUT = Path(__file__).resolve().parent
SCORES = OUT / "scores"

# A note is (step, quarterLength). Rests use None.
Note = tuple[str | None, float]

Q = 1.0
H = 2.0
W = 4.0
E = 0.5
DQ = 1.5


TWINKLE_RH: list[Note] = [
    # 1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - |
    ("C5", Q), ("C5", Q), ("G5", Q), ("G5", Q),
    ("A5", Q), ("A5", Q), ("G5", H),
    ("F5", Q), ("F5", Q), ("E5", Q), ("E5", Q),
    ("D5", Q), ("D5", Q), ("C5", H),
    # 5 5 4 4 | 3 3 2 - | 5 5 4 4 | 3 3 2 - |
    ("G5", Q), ("G5", Q), ("F5", Q), ("F5", Q),
    ("E5", Q), ("E5", Q), ("D5", H),
    ("G5", Q), ("G5", Q), ("F5", Q), ("F5", Q),
    ("E5", Q), ("E5", Q), ("D5", H),
    # 1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - |
    ("C5", Q), ("C5", Q), ("G5", Q), ("G5", Q),
    ("A5", Q), ("A5", Q), ("G5", H),
    ("F5", Q), ("F5", Q), ("E5", Q), ("E5", Q),
    ("D5", Q), ("D5", Q), ("C5", H),
]
TWINKLE_LH = ["C3", "F3", "F3", "G3", "C3", "G3", "C3", "G3", "C3", "F3", "F3", "C3"]


ODE_RH: list[Note] = [
    # 3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3. 2 2 - |
    ("E5", Q), ("E5", Q), ("F5", Q), ("G5", Q),
    ("G5", Q), ("F5", Q), ("E5", Q), ("D5", Q),
    ("C5", Q), ("C5", Q), ("D5", Q), ("E5", Q),
    ("E5", DQ), ("D5", E), ("D5", H),
    # 3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 2. 1 1 - |
    ("E5", Q), ("E5", Q), ("F5", Q), ("G5", Q),
    ("G5", Q), ("F5", Q), ("E5", Q), ("D5", Q),
    ("C5", Q), ("C5", Q), ("D5", Q), ("E5", Q),
    ("D5", DQ), ("C5", E), ("C5", H),
]
ODE_LH = ["C3", "G3", "C3", "G3", "C3", "G3", "C3", "C3"]


FRERE_RH: list[Note] = [
    # 1 2 3 1 | 1 2 3 1 | 3 4 5 - | 3 4 5 - |
    ("C5", Q), ("D5", Q), ("E5", Q), ("C5", Q),
    ("C5", Q), ("D5", Q), ("E5", Q), ("C5", Q),
    ("E5", Q), ("F5", Q), ("G5", H),
    ("E5", Q), ("F5", Q), ("G5", H),
    # 5 6 5 4 3 1 | 5 6 5 4 3 1 | 1 5, 1 - | 1 5, 1 - |
    ("G5", E), ("A5", E), ("G5", E), ("F5", E), ("E5", Q), ("C5", Q),
    ("G5", E), ("A5", E), ("G5", E), ("F5", E), ("E5", Q), ("C5", Q),
    ("C5", Q), ("G4", Q), ("C5", H),
    ("C5", Q), ("G4", Q), ("C5", H),
]
# Frère Jacques is a round over a tonic pedal.
FRERE_LH = ["C3", "C3", "C3", "C3", "C3", "C3", "C3", "C3"]


JASMINE_RH: list[Note] = [
    # 好一朵美丽的茉莉花
    # 3 3 5 6 | 5 - 3 5 | 6 5 6 5 | 3 - - - |
    ("E5", Q), ("E5", Q), ("G5", Q), ("A5", Q),
    ("G5", H), ("E5", Q), ("G5", Q),
    ("A5", Q), ("G5", Q), ("A5", Q), ("G5", Q),
    ("E5", W),
    # 好一朵美丽的茉莉花
    # 3 3 5 6 | 5 - 3 5 | 6 5 6 5 | 3 - - - |
    ("E5", Q), ("E5", Q), ("G5", Q), ("A5", Q),
    ("G5", H), ("E5", Q), ("G5", Q),
    ("A5", Q), ("G5", Q), ("A5", Q), ("G5", Q),
    ("E5", W),
]
JASMINE_LH = ["C3", "C3", "F3", "C3", "C3", "C3", "F3", "C3"]


SONGS = [
    {
        "scoreId": "twinkle_star",
        "title": "小星星",
        "subtitle": "Twinkle, Twinkle, Little Star",
        "tempo": 92,
        "rh": TWINKLE_RH, "lh": TWINKLE_LH,
    },
    {
        "scoreId": "ode_to_joy",
        "title": "欢乐颂",
        "subtitle": "Ode to Joy · Beethoven",
        "tempo": 100,
        "rh": ODE_RH, "lh": ODE_LH,
    },
    {
        "scoreId": "two_tigers",
        "title": "两只老虎",
        "subtitle": "Frère Jacques",
        "tempo": 108,
        "rh": FRERE_RH, "lh": FRERE_LH,
    },
    {
        "scoreId": "jasmine_flower",
        "title": "茉莉花",
        "subtitle": "Jiangsu folk song",
        "tempo": 76,
        "rh": JASMINE_RH, "lh": JASMINE_LH,
    },
]


def _fill_measures(part: music21.stream.Part, notes: list[Note],
                   beats_per_measure: float) -> int:
    """Lay notes into 4/4 bars, asserting each bar is exactly full."""
    measure = music21.stream.Measure()
    filled = 0.0
    count = 0
    for step, length in notes:
        element = (music21.note.Rest(quarterLength=length) if step is None
                   else music21.note.Note(step, quarterLength=length))
        measure.append(element)
        filled += length
        if filled >= beats_per_measure - 1e-9:
            if abs(filled - beats_per_measure) > 1e-9:
                raise ValueError(f"bar {count + 1} holds {filled} beats")
            part.append(measure)
            measure = music21.stream.Measure()
            filled = 0.0
            count += 1
    if filled > 1e-9:
        raise ValueError(f"trailing partial bar of {filled} beats")
    return count


def build(song: dict) -> music21.stream.Score:
    score = music21.stream.Score()
    score.metadata = music21.metadata.Metadata()
    score.metadata.title = song["title"]
    score.metadata.movementName = song["title"]
    score.metadata.composer = song["subtitle"]

    right = music21.stream.Part()
    right.partName = "Right Hand"
    right.append(music21.instrument.Piano())
    right.append(music21.clef.TrebleClef())
    right.append(music21.key.KeySignature(0))
    right.append(music21.meter.TimeSignature("4/4"))
    bars = _fill_measures(right, song["rh"], 4.0)
    # A MetronomeMark appended to the Part is dropped on MusicXML export; it has
    # to live inside the first measure to survive as a <direction>.
    right.measure(1).insert(0, music21.tempo.MetronomeMark(number=song["tempo"]))

    left = music21.stream.Part()
    left.partName = "Left Hand"
    left.append(music21.instrument.Piano())
    left.append(music21.clef.BassClef())
    left.append(music21.key.KeySignature(0))
    left.append(music21.meter.TimeSignature("4/4"))
    if len(song["lh"]) != bars:
        raise ValueError(
            f"{song['scoreId']}: {len(song['lh'])} bass notes for {bars} bars")
    _fill_measures(left, [(pitch, 4.0) for pitch in song["lh"]], 4.0)

    score.insert(0, right)
    score.insert(0, left)
    return score


def main() -> None:
    SCORES.mkdir(parents=True, exist_ok=True)
    written = []
    for song in SONGS:
        score = build(song)
        path = SCORES / f"{song['scoreId']}.musicxml"
        score.write("musicxml", fp=str(path))
        bars = len(song["lh"])
        written.append({
            "scoreId": song["scoreId"], "title": song["title"],
            "musicxml": f"scores/{song['scoreId']}.musicxml",
            "tempo": float(song["tempo"]), "measureCount": bars,
            "eventCount": len(song["rh"]) + bars, "samples": [],
        })
        print(f"  {song['title']:8} {bars:2d} bars, {len(song['rh']):3d} melody notes"
              f"  -> {path.name}")

    # Merge into the fixture manifest without disturbing the controlled samples.
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    by_id = {item["scoreId"]: item for item in manifest}
    for item in written:
        by_id[item["scoreId"]] = {**by_id.get(item["scoreId"], {}), **item}
    ordered = [by_id[item["scoreId"]] for item in written] + [
        entry for entry in manifest
        if entry["scoreId"] not in {item["scoreId"] for item in written}
    ]
    manifest_path.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n")
    print(f"manifest: {len(ordered)} entries")


if __name__ == "__main__":
    main()
