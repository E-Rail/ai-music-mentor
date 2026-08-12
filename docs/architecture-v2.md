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

## Following the player

`features/live/passageProgress` holds the whole rule, and both input sources use it.

A position on the page is one onset, however many staves it is written across. It is finished when every note in it has sounded — the two hands may land 20 ms or 400 ms apart, and it is still one position. Nothing advances until it is finished.

A pitch that is written nowhere at this position is a **wrong note here**. The passage holds, names what it is still owed and which hand owes it, and looks no further. It is never matched against another position in the score. An earlier version ran a beam-search follower with a two-onset lookahead and a six-onset backward re-lock, which relocated mistakes and sometimes carried the student several notes past where they were; that follower is gone, and the live cursor now reads directly off this rule with no second opinion to reconcile.

The one exception is not a wrong note. A student practising one hand leaves the other hand's notes unplayed on purpose. So a strike this position does not want, that the *immediately next* position does, played after this position has been begun, is read as a missed note and moves on by exactly one. One step, to the note that is literally next — never a search.

When neither applies the player is stuck on purpose, and `跳过这个音` is theirs to press. The app never decides on its own that a wrong note meant something else.

Timing is claimed once per position, from the first correct note that lands there. A second hand arriving afterwards belongs to the same onset, and a note played where the passage is held has no onset to be measured against, so it makes no claim at all. The player's tempo is the median of their own recent beat-to-time intervals.

MIDI keys struck within 70 ms are one gesture. The window runs from the first key and is never extended — restarting it on every key turned a fast run into one enormous chord. Hands further apart than that are still one position; the passage waits for them rather than relying on the window.

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
