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
- PDF: `PdfOmrImporter` is present but returns a clear next-milestone error.

## Runtime boundaries

- `FileStore`: local files now; opaque storage keys and artifact metadata allow object storage later.
- SQLAlchemy repositories: SQLite now; explicit tables, portable JSON columns, foreign keys, and Alembic allow PostgreSQL later.
- Analysis jobs: persistent `queued/running/completed/failed` records with an in-process executor. A queue worker can call the same job body later.
- Frontend workflow: a guarded reducer owns import → review → device setup → count-in → recording → analysis → report → exercise → retry → comparison. IndexedDB remains the first recovery copy; idempotent batches mirror every two seconds.

## Privacy and retention

There is one local profile. Uploads are private and never redistributed. Abandoned captures are marked after 24 hours. Generated artifacts expire after seven days by default; uploaded score sources do not expire.
