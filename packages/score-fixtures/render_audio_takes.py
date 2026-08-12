"""Render the MIDI takes to piano-like audio, so the microphone path can be
measured against notes we already know.

A transcription engine can only be judged against ground truth, and the one
ground truth we have is the MIDI the take was built from. Recording a real piano
would be more faithful but not *known* — nobody can say afterwards exactly which
notes were struck at exactly which millisecond. So the notes come from the file,
and the timbre is synthesised here.

This is additive synthesis with the properties that matter to a transcriber: a
harmonic series that rolls off, higher partials that die sooner than the
fundamental, a percussive attack, and the slight inharmonicity of a real string.
It is not a convincing piano to a listener. It is close enough to compare two
engines fairly, because both hear exactly the same file.

Usage:
    .venv/bin/python packages/score-fixtures/render_audio_takes.py
"""
from __future__ import annotations

import math
import wave
from pathlib import Path

import zlib

import mido
import numpy as np

SAMPLE_RATE = 44_100
HARMONICS = 12
#: Stiffness of the string. Real piano wire is dispersive, so upper partials sit
#: slightly sharp of a perfect multiple; a transcriber trained on real pianos
#: expects that.
INHARMONICITY = 1.2e-4
ATTACK_SECONDS = 0.006
RELEASE_SECONDS = 0.18
#: Hammer noise. A struck string starts with a broadband click, and that click
#: is most of what an onset detector actually keys on. Without it a repeated
#: note is only a smooth swell in an already-ringing partial, and every engine
#: misses the repeat — which is a fact about this renderer, not about the model.
HAMMER_SECONDS = 0.012
HAMMER_GAIN = 0.22
#: A key has to come up before it can go down again. Shortening the written
#: duration is what puts a damped moment between two strikes of the same note.
FINGER_LIFT_SECONDS = 0.05

REPO_ROOT = Path(__file__).resolve().parents[2]
MIDI_DIR = REPO_ROOT / "packages/score-fixtures/midi/live"
OUT_DIR = REPO_ROOT / "apps/web/public/fixtures/audio"


def decay_seconds(pitch: int) -> float:
    """Bass strings ring far longer than treble ones."""
    return 9.0 * math.exp(-(pitch - 21) / 46.0) + 0.45


def render_note(buffer: np.ndarray, pitch: int, start_s: float,
                duration_s: float, velocity: int, rng: np.random.Generator) -> None:
    f0 = 440.0 * 2 ** ((pitch - 69) / 12)
    if f0 <= 0:
        return
    amplitude = (velocity / 127.0) ** 1.4 * 0.22
    tau = decay_seconds(pitch)
    # A key held down still decays; a key released damps quickly. Sound past the
    # written duration is real piano behaviour and the engines must cope with it.
    held_s = max(0.04, duration_s - FINGER_LIFT_SECONDS)
    total_s = min(held_s + RELEASE_SECONDS + tau * 0.6, held_s + 3.0)
    start = int(start_s * SAMPLE_RATE)
    count = int(total_s * SAMPLE_RATE)
    if start + count > len(buffer):
        count = len(buffer) - start
        if count <= 0:
            return

    t = np.arange(count) / SAMPLE_RATE
    released = held_s
    # One envelope shape for the whole note: struck, ringing, then damped when
    # the finger comes off.
    damping = np.where(t > released,
                       np.exp(-3.0 * (t - released) / RELEASE_SECONDS), 1.0)
    attack = np.clip(t / ATTACK_SECONDS, 0.0, 1.0)

    voice = np.zeros(count)
    for harmonic in range(1, HARMONICS + 1):
        frequency = f0 * harmonic * math.sqrt(1 + INHARMONICITY * harmonic ** 2)
        if frequency >= SAMPLE_RATE / 2:
            break
        # Upper partials are quieter to begin with and fade sooner.
        partial_gain = amplitude / harmonic ** 1.3
        partial_tau = tau / (1 + 0.55 * (harmonic - 1))
        # Every strike starts its partials at a fresh phase, as a new hammer
        # blow does. Reusing phase 0 makes a repeated note add coherently to the
        # note still ringing underneath it, and the repeat stops being audible
        # as a separate event at all.
        phase = rng.uniform(0, 2 * math.pi)
        voice += partial_gain * np.exp(-t / partial_tau) * np.sin(
            2 * math.pi * frequency * t + phase)
    voice *= attack * damping

    hammer_len = int(HAMMER_SECONDS * SAMPLE_RATE)
    if hammer_len > 1:
        hammer_t = t[:hammer_len]
        voice[:hammer_len] += (
            rng.normal(0, 1, hammer_len)
            * amplitude * HAMMER_GAIN
            * np.exp(-hammer_t / (HAMMER_SECONDS / 3)))

    buffer[start:start + count] += voice


def notes_of(path: Path) -> list[tuple[int, float, float, int]]:
    """(pitch, start seconds, duration seconds, velocity), in time order."""
    midi = mido.MidiFile(path)
    sounding: dict[int, tuple[float, int]] = {}
    notes: list[tuple[int, float, float, int]] = []
    now = 0.0
    for message in midi:
        now += message.time
        if message.type == "note_on" and message.velocity > 0:
            sounding[message.note] = (now, message.velocity)
        elif message.type == "note_off" or (
                message.type == "note_on" and message.velocity == 0):
            started = sounding.pop(message.note, None)
            if started is not None:
                notes.append((message.note, started[0], max(0.05, now - started[0]),
                              started[1]))
    for pitch, (start, velocity) in sounding.items():
        notes.append((pitch, start, 0.5, velocity))
    return sorted(notes, key=lambda note: (note[1], note[0]))


def write_wav(path: Path, buffer: np.ndarray) -> None:
    peak = float(np.max(np.abs(buffer))) if buffer.size else 0.0
    gain = 0.89 / peak if peak > 0 else 1.0
    samples = np.clip(buffer * gain, -1.0, 1.0)
    frames = (samples * 32_767).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(frames)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, object]] = []
    for source in sorted(MIDI_DIR.glob("*.mid")):
        notes = notes_of(source)
        if not notes:
            continue
        # Seeded per file, so a re-render produces byte-identical audio and a
        # measurement can be compared with the one before it.
        rng = np.random.default_rng(zlib.crc32(source.stem.encode()))
        # Long enough for the last note plus its whole decay, so nothing
        # has to grow the buffer mid-render.
        tail = max(start + duration for _, start, duration, _ in notes)
        buffer = np.zeros(int((tail + 6.0) * SAMPLE_RATE))
        for pitch, start, duration, velocity in notes:
            # A second of room before the first note, as in a real take.
            render_note(buffer, pitch, start + 1.0, duration, velocity, rng)
        target = OUT_DIR / f"{source.stem}.wav"
        write_wav(target, buffer)
        index.append({
            "name": source.stem,
            "audio": f"/fixtures/audio/{target.name}",
            "notes": [
                {"pitch": pitch, "onsetMs": round((start + 1.0) * 1000, 1),
                 "durationMs": round(duration * 1000, 1)}
                for pitch, start, duration, _ in notes
            ],
        })
        print(f"{target.name}: {len(notes)} notes, "
              f"{len(buffer) / SAMPLE_RATE:.1f}s")

    import json
    (OUT_DIR / "index.json").write_text(
        json.dumps(index, indent=2), encoding="utf-8")
    print(f"wrote {OUT_DIR / 'index.json'}")


if __name__ == "__main__":
    main()
