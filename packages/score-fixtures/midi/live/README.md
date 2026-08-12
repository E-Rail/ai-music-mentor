# Sample takes for the live layer

Four short performances of 小星星 bars 1–4, each aimed at one thing the live
layer has to get right. The notes come from the app's own importer reading the
demo score, so a sample cannot drift away from the page it is meant to match.

| file | what it plays | what should happen |
|---|---|---|
| `twinkle-correct.mid` | both hands, as written | walks bar 1 beat 1 → bar 4 beat 3, every position 和谱面一致 |
| `twinkle-hands-apart.mid` | left hand lands 260 ms after the right | the panel says 还差 左手C3, then the same position completes — the position never shifts |
| `twinkle-left-hand-struggling.mid` | left hand lands most of a bar late | the right hand runs on undisturbed and each late left-hand note is credited to its own position, because the page holds it that long |
| `twinkle-wrong-note-fixed.mid` | B♭4 instead of A4 in bar 2, then corrected | holds at bar 2 beat 1 until A4 arrives, then 已更正 and carries on |
| `twinkle-wrong-note-held.mid` | the same wrong note, played straight past | holds; every later note is judged against the position it is holding, and the passage never runs ahead |

Regenerate: `.venv/bin/python packages/score-fixtures/generate_live_takes.py`

## The same takes, as audio

`render_audio_takes.py` renders each of these to a piano-like WAV under
`apps/web/public/fixtures/audio/`, alongside an `index.json` naming every note
and its onset. That is what lets the microphone path be scored: the reference is
exact, because the audio was built from it.

```
.venv/bin/python packages/score-fixtures/render_audio_takes.py
cd apps/web && node scripts/audit-transcription.mjs
```

The audit runs every engine over identical audio and reports note-onset
precision, recall and F1 against the known notes. `MISSES=1` lists which notes
each engine dropped and which it invented.

The timbre is additive synthesis, not a recording — good enough to rank two
engines fairly, since both hear the same file, but not a substitute for a real
piano. Both engines under-detect *repeated* notes on this material more than
they would on a real instrument, so read the columns against each other rather
than as absolute accuracy.

## Playing one

With the API on `:8000` and the web app on `:5173`:

```
cd apps/web
node scripts/play-midi-take.mjs ../../packages/score-fixtures/midi/live/twinkle-correct.mid
```

It opens the app, picks the song, sets the practice range, and plays the file in
real time through a simulated USB keyboard, printing what the live panel made of
every strike. `HEADED=1` opens a real window to watch it; `SONG=`, `BARS=` and
`SHOT=path.png` are the other options.

## Playing one into a real browser

These are ordinary MIDI files, so any player can send them to the app through a
virtual port. On macOS: open **Audio MIDI Setup → Window → Show MIDI Studio**,
double-click **IAC Driver** and tick *Device is online*. Play the file into
**IAC Bus 1** from any MIDI player, and pick that port in the app's device check.
