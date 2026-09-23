# AI Music Mentor

English | [中文](README-zh.md)

An AI-assisted piano practice app for beginner-to-intermediate players. Import sheet music or MIDI, play it once with a MIDI keyboard or microphone, and get a diagnosis, targeted micro-exercises, accompaniment playback, and before-and-after comparisons.

## Try the web app

**<https://ai-music-mentor.onrender.com/>**

No installation is required. Keep these three things in mind:

- **Use Chrome or Edge for a MIDI keyboard.** The app uses Web MIDI, which is not available in Safari or Firefox. Microphone input works in any modern browser.
- **The hosted app sleeps after 15 minutes of inactivity.** The first request afterwards can take about 40 seconds. Open it once before a demo so the service is warm.
- **Practice history does not survive restarts or redeploys.** The score library and diagnosis still work; only previous practice records are cleared.

## Run locally

macOS / Linux:

```bash
bash launch.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch.ps1
```

The launcher installs dependencies on first run, creates or updates the database, builds the web app, starts the API, and opens <http://127.0.0.1:8000>. It sets up the project-local Python `.venv` and web dependencies for you, so no global pnpm installation is required.

Stop the local services with:

```bash
bash quit.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File .\quit.ps1
```

Only services started from this checkout are stopped.

Two things to remember:

- After changing code, run `quit` and then `launch` so the browser is using a fresh build.
- Do not open `apps/web/index.html` directly; the app needs the API server.

## Deploy it yourself

On a server, or anywhere you want the steps on the record rather than inside a script. Needs Python 3.12 or newer and Node.js with pnpm 11 (`corepack enable` provides it).

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt                        # every Python package the API imports
(cd apps/web && pnpm install --frozen-lockfile && pnpm build)    # the page the API serves
(cd apps/api && ../../.venv/bin/python -m alembic upgrade head)  # create or update the database
(cd apps/api && ../../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000)
```

One process is the whole app: the API serves the built page on the same port, at <http://your-host:8000>. On Windows the interpreter is `.venv\Scripts\python`. A container runs the same steps; `compose.yaml` and `render.yaml` wrap them.

## Settings

The gear menu in the top-right corner contains four settings, all applied immediately:

- **Theme** — Light, dark, or follow the system setting.
- **Piano finish** — Ebony, rosewood, walnut, or ivory. This changes the piano and background only: notation remains paper-like and wrong notes remain red, so reports stay visually consistent across themes.
- **Language** — Simplified Chinese, English, or follow the system setting. The initial language is detected from the browser; Traditional Chinese falls back to Simplified Chinese. Everything follows it, including the report and the AI mentor's replies; an open report switches language on the spot, and an AI summary written before the switch can be rewritten with one click. Changing the language during a recording does not interrupt the take.
- **Detail level** — Both modes look the same; Pro only shows more. Standard focuses on what to practise. Pro adds itemised evidence, per-note confidence, separate left- and right-hand statistics, recording quality (room noise, accepted versus discarded notes) and a curve of the tempo you actually kept.

## Supported inputs

- **`.musicxml` / `.xml` / `.mxl`** — Preserves precise original notation.
- **`.mid` / `.midi`** — Uses the original MIDI as the playback timeline and displays a clearly labelled, quantised simplified staff. Review the tempo, time signature, and left/right-hand mapping after import.
- **`.pdf` and images** (`.png` / `.jpg` / `.webp` / `.heic`) — Uses a vision model to read the music. Up to two pages can be imported at once. Always review the result; key signatures, ties, and hand assignments are the easiest details to misread.

## Configure an AI model (optional)

The app works without an external model: it falls back to a deterministic Chinese rule-based mentor, and the complete practice loop still works. To connect an OpenAI-compatible provider:

```bash
cp .env.example .env      # then set MENTOR_API_KEY
```

The main options are shown below. `.env.example` explains the reasoning behind each value:

```bash
MENTOR_API_BASE=https://openrouter.ai/api/v1
MENTOR_API_KEY=your-server-side-key
MENTOR_MODEL=openai/gpt-oss-120b     # measured choice; worst of three calls: 2.1s
MENTOR_MAX_OUTPUT_TOKENS=4000        # 1600 can truncate an exercise plan
MENTOR_PROVIDER_ORDER=cerebras,groq  # one value; the comma is part of it
VISION_MODEL=xiaomi/mimo-v2.5        # notation reading; reuses the mentor base/key
```

Credentials stay on the server. `.env` is ignored by Git, and the hosted deployment stores its key in Render.

Before changing the model or timeout values, benchmark the available models:

```bash
.venv/bin/python scripts/bench_mentor_models.py
```

## Tests

```bash
python -m pytest tests -q          # backend, importers, and algorithm regressions
cd apps/web && pnpm test           # frontend state machine
pnpm build                         # types and production build
pnpm test:e2e                      # mocked Web MIDI flow; first run:
                                   # pnpm exec playwright install chromium
```

## More documentation

- API documentation: <https://ai-music-mentor.onrender.com/docs> (local: <http://127.0.0.1:8000/docs>)
- Design decisions: [v2 architecture](docs/architecture-v2.md)
- Hardware validation: [USB MIDI checklist](docs/hardware-acceptance.md)

## License

GPL-3.0
