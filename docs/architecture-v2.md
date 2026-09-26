# Production-shaped demo v2 architecture

The demo intentionally remains a single-user application. Its boundaries are shaped so authentication, an external job queue, PostgreSQL, object storage, and PDF OMR can be attached later without rewriting musical truth.

## Truth and explanation

- `services/alignment`, `services/diagnosis`, `services/generation`, and the controlled fixtures own scoring, evidence, confidence, exercises, accompaniment, and comparison.
- Every immutable report records `algorithmVersion`, `thresholdProfile`, `scoreHash`, and source references.
- The mentor receives a bounded report payload and deterministic exercise candidates. Its validated prose is never read back into scores or facts.

## Import boundary

`ScoreImporter` produces one `NormalizedScore` contract.

- MusicXML/XML/MXL: exact render artifact plus deterministic events. MXL is read in memory with archive-size, path, link, and encryption checks.
- MIDI: original timeline artifact plus a quantized simplified MusicXML render. Missing tempo and meter default to 120 BPM and 4/4. The user confirms tempo, meter, grid, and track mapping.
- Photo and PDF: `VisionScoreImporter` sends page images to a multimodal model and gets back **notes**, never MusicXML. Deterministic code turns those notes into a score with the same builder the exercise generator uses, and the result is then re-imported through `MusicXmlImporter`, so a read page passes exactly the checks an uploaded file passes. The photo is kept as the source artifact, the score is marked `simplified_quantized_staff` with the model's confidence, and a warning says it is a reading rather than a record.

## Bar numbers

`measureNo` is a position in the performance timeline and always counts 1, 2, 3…; it is what alignment, event IDs and the follower use. What the page prints can differ — a pickup bar is printed 0, so every printed number after it is one lower than its position. `ScoreMeta.measureLabels` carries the printed name of each bar, the browser publishes it once per score in `features/score/measureLabels`, and the same list is written into the MusicXML before it is engraved. The page and every sentence about it therefore agree by construction.

## Hearing the take

Two models transcribe microphone audio, and `features/microphone/transcriptionEngines` is the only place that knows there is more than one. It holds the table — which worker, at which sample rate, under which name, with how long that model may go quiet — and the one piece of plumbing that runs any of them. A new engine is a row plus a worker that speaks `features/microphone/engineProtocol`. Both workers return `PerformanceEvent[]` through the same cleanup, so nothing downstream can tell which one ran.

**Basic Pitch hears every take; Onsets and Frames stays registered.** Magenta's piano-specific model is more accurate on paper (95.2 note F1 on MAESTRO against Basic Pitch's 70.9), but in the browser it runs one uninterruptible pass at roughly twice the length of the audio on a real GPU and far slower on software WebGL, so it is kept for comparison and as a row the table can switch back to. Basic Pitch is the default for every instrument.

**What counts as a note is decided by the attack, not by the sound.** A transcriber that reports "a pitch was sounding" re-reads a held left-hand note at every right-hand strike over it, and hears a G6 overtone for every G4. The old cleanup merged same-pitch fragments separated only by silence, which folded every repeated note — the second C of "C C G G" — into the first, so the student was told they had missed notes they played. `features/microphone/noteCleanup` now asks Basic Pitch's onset head whether a key was struck at each note's first frame. For piano: a note struck firmly (attack ≥ 0.7) is a note, even the same pitch straight again; a note with no attack that continues a sounding note of its pitch lengthens that note; a weak upper partial of a note struck with it is its overtone; everything else is not a note. Measured through the app's own worker on the five rendered takes, Basic Pitch went from 70 of 91 notes found with 154 reported (F1 57%) to 91 of 91 with 91 reported (F1 100%), and held 99–100% with room noise mixed in at 20 and 10 dB — real attacks never scored under 0.84, re-reads and overtones never over 0.76. Onsets and Frames only emits struck notes, so none of its notes are merged any more; its recall on the same takes went from 78% to 100%. Guitar and violin have no measurements yet and keep the old rule, except that a clear attack now also stops a merge. `node scripts/audit-transcription.mjs` reproduces every number here.

The audio is decoded and resampled on the main thread, at the rate each model was trained on — 16 kHz for Onsets and Frames, 22.05 kHz for Basic Pitch — because a worker has no `AudioContext`. Onsets and Frames runs one uninterruptible pass over the whole take with no way to hook its progress, so it is silent for roughly twice the duration of the audio on a real GPU; its silence budget is a property of the model and lives in its row. If it cannot start at all — no checkpoint, no WebGL — the take falls back to Basic Pitch rather than being lost, and the report records which engine actually ran.

The two engines carry different TensorFlow.js majors (2.8.6 and 3.21.0). They never meet: each runs in its own worker, and a worker is its own realm, so the backend registries are separate by construction. `@magenta/music` itself is carried with a patch (`apps/web/patches`), because upstream builds an `OfflineAudioContext` at module scope — fatal on import inside a worker — and its ES modules assume webpack's CommonJS interop.

## Following the player

`features/live/passageProgress` holds the whole rule, and both input sources use it.

**Each hand travels on its own.** A single cursor through the page cannot describe two-handed music: bar 1 of 小星星 is four right-hand quarter notes over one left-hand whole note, so while the right hand is on beat 3 the left hand is still on the note it struck at beat 1, because the page says to hold it. A shared cursor has to call one of those two positions wrong, and it is always the late-arriving hand that gets punished — which is how a two-handed take stopped dead on its first chord. So each hand walks its own lane, and a played note goes to the hand that is waiting for it. The hands need no coordination at all: they may land together or a beat apart and both are simply correct.

A hand may lag only while the page still holds its note. Once its note has stopped sounding and never arrived, that note is *missed*, and the hand is brought up to where the music now is — measured by the beat of the latest position where something correct actually sounded, never by another lane's cursor. A hand that has just finished a whole note points at a bar nobody has played yet; reading that as "the music has moved on" lets the other hand skip the note it is sitting on.

**A wrong note stops its hand where it is.** A pitch no lane is waiting for is a wrong note at the position that hand is on. It is never matched against another position in the score, and it never moves anything forward. The passage holds, names what it is still owed and which hand owes it, and looks no further. An earlier version ran a beam-search follower with a two-onset lookahead and a six-onset backward re-lock; it relocated mistakes and sometimes carried the student several notes past where they were. That follower is gone, and the live cursor reads directly off this rule with no second opinion to reconcile.

The one exception is not a wrong note. Hands-separate practice leaves the other hand out on purpose, so a strike a lane's position does not want, that the lane's *immediately next* position does, played after that position has been begun or passed, is a missed note and moves that lane on by exactly one. One step, to the note that is literally next — never a search.

When neither applies the player is stuck on purpose, and `跳过这个音` is theirs to press. The app never decides on its own that a wrong note meant something else.

Timing is claimed once per position, from the first correct note that lands there. A second hand arriving afterwards belongs to the same onset, and a note played where the passage is held has no onset to be measured against, so it makes no claim at all. The player's tempo is the median of their own recent beat-to-time intervals.

MIDI keys struck within 70 ms are one gesture. The window runs from the first key and is never extended — restarting it on every key turned a fast run into one enormous chord. Hands further apart than that are still one position; the lanes handle them, and the window is not asked to.

## Reading the page, not only the notes

A score asks for more than pitches at times, and a report that ignores the rest faults a player for reading it correctly.

- **Ties.** The second half of a tie is written again but held, not struck. The importer folds it into the note it continues, so holding a tie is no longer a missed note.
- **Fermatas.** The gap after one is the player's to choose. The tempo fit treats any extra time there as a jump in the timeline, never as tempo, and no rule calls it a stop.
- **Written tempo.** `ScoreMeta.tempoPlan` holds each metronome mark and each *rit.*/*rall.*/*accel.*/*a tempo* in timeline beats. The tempo rules read the played tempo as a share of the written one at each point and leave out the stretches under a written change; the tempo curve draws the marking as steps and shades the written slowing.
- **Articulation and shaping** (`diagnosis/expression.py`), judged only where the input measured it — key releases and velocities come from a keyboard, not a microphone: staccato held too long, slurred notes not joined, accents not louder than their neighbours, hairpins that did not grow or fade. One finding per phrase, not per note. A note let go under the sustain pedal (`PerformanceEvent.pedalAtRelease`, from Web MIDI and from uploaded files' CC64) kept sounding, so its length is not judged.
- **Length per hand.** A right-hand crotchet over a left-hand semibreve is two lengths; each hand is judged against its own.

**Stops and restarts** (`diagnosis/fluency.py`) are the first thing a teacher hears and used to be invisible: the tempo map absorbed a stop, and a passage played again became a burst of "extra notes". A stop is defined once, in `alignment/tempo.stop_excess`, and used twice: the tempo fit makes it a jump (so the notes around it are not early or late), and the report names it. A restart is found in the played notes *before* alignment — the same run twice, a hiccup between, where the score does not repeat it — and the abandoned attempt is set aside so the attempt that carried on is the one read against the score. Each is one event, costs fluency once, and is cut out of the timeline before tempo is measured, so it is not also reported as the tempo sagging.

**The first note starts the clock** in the analysis as it does live: the first played onset always anchors the tempo fit, even when its chord is missing a voice.

**One record of where every written note went.** A chord played apart lands in several played groups; the classifier's chord-spread absorption already knew which. `Findings.arrivals` keeps that record (onset → pitch → group, time), and the per-hand profile (`diagnosis/performance.py`) reads it, so a left hand 260 ms late is measured as late, not as missing.

## Pitch, and where a note is drawn

MIDI numbers are the product's one pitch unit — the keyboard, the alignment, the report and the mentor all speak them. OpenSheetMusicDisplay reports half tones an octave lower, so `features/score/pitch` converts at that boundary, the way the pixel scale already does. The same module owns both how a pitch is spelled and which staff line that spelling sits on, because they are one decision: a MIDI 70 named `B♭4` has to be drawn on the B line, not the A space.

Pitch → height is fitted from the notes the renderer actually engraved, **once per staff per system**. A staff is only vertically continuous within one line of music, so a single fit across the page averages every system together and puts the note above the staff, on no pitch at all. A staff that rests through a line borrows the nearest line's fit, moved by the distance between them.

Which staff a played note lands on is decided by its register, with the score's hand hint as a preference rather than a command — a chord written across both hands hints at only one of them, and the live layer draws the note that sounded.

Labels hung off a point on the page (the played note, the follower's tag, an error marker) are placed by `features/score/overlayLabels`: above and centred in the middle of the page, flipped or tucked in at its edges, so none of them can leave the paper.

## Layout: the box, not the window

A component does not know where it has been put. The microphone panel is the whole page during setup and a 372px rail while you play, at one and the same window size — so a window-width media query cannot tell those apart, and it once spilled 258px off the side of the page. Boxes that hand out an arbitrary width declare `container-type: inline-size`, and the components inside them size themselves with `@container`. Defaults are always the narrow layout, so a missing container costs a column rather than causing an overflow. Grid tracks that must fit an unknown box use `minmax(0, …)` or `minmax(min(Npx, 100%), …)`; a bare px minimum is what an overflow looks like before it happens.

`scripts/lib/overflow.mjs` is the shared probe for both `audit-layout.mjs` and the demo-flow check, which asserts at every stage that nothing paints outside its box.

## Runtime boundaries

- `FileStore`: local files now; opaque storage keys and artifact metadata allow object storage later.
- SQLAlchemy repositories: SQLite now; explicit tables, portable JSON columns, foreign keys, and Alembic allow PostgreSQL later.
- Analysis jobs: persistent `queued/running/completed/failed` records with an in-process executor. A queue worker can call the same job body later.
- Frontend workflow: a guarded reducer owns import → review → device setup → count-in → recording → analysis → report → exercise → retry → comparison. IndexedDB remains the first recovery copy; idempotent batches mirror every two seconds.

## Privacy and retention

There is one local profile. Uploads are private and never redistributed. Abandoned captures are marked after 24 hours. Generated artifacts expire after seven days by default; uploaded score sources do not expire.
