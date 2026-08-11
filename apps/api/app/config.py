"""Environment configuration for the production-shaped local application."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[3]   # ai-music-mentor/
# Local desktop launches do not inherit Docker Compose's automatic .env loading.
# Existing process/container variables always win over values in the local file.
load_dotenv(BASE_DIR / ".env", override=False)

DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()

APP_ENV = os.environ.get("APP_ENV", "development")
DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'app.db'}")
FILE_STORAGE_DIR = Path(os.environ.get("FILE_STORAGE_DIR", DATA_DIR / "files")).resolve()
# Compatibility paths used by deterministic generators. New uploads go through FileStore.
SCORE_STORAGE_DIR = Path(os.environ.get("SCORE_STORAGE_DIR", FILE_STORAGE_DIR / "scores")).resolve()
SESSION_STORAGE_DIR = Path(os.environ.get("SESSION_STORAGE_DIR", FILE_STORAGE_DIR / "sessions")).resolve()
GENERATED_STORAGE_DIR = Path(os.environ.get("GENERATED_STORAGE_DIR", FILE_STORAGE_DIR / "generated")).resolve()
FIXTURES_DIR = Path(os.environ.get("FIXTURES_DIR", BASE_DIR / "packages" / "score-fixtures"))
WEB_DIST_DIR = Path(os.environ.get("WEB_DIST_DIR", BASE_DIR / "apps" / "web" / "dist")).resolve()

MENTOR_API_BASE = os.environ.get("MENTOR_API_BASE", "").rstrip("/")
MENTOR_API_KEY = os.environ.get("MENTOR_API_KEY", "")
MENTOR_MODEL = os.environ.get("MENTOR_MODEL", "")
MENTOR_RESPONSE_MODE = os.environ.get("MENTOR_RESPONSE_MODE", "json_object")
MENTOR_REASONING_EFFORT = os.environ.get("MENTOR_REASONING_EFFORT", "low").lower()
MENTOR_TIMEOUT_SECONDS = float(os.environ.get("MENTOR_TIMEOUT_SECONDS", "40"))
MENTOR_CONNECT_TIMEOUT_SECONDS = float(os.environ.get(
    "MENTOR_CONNECT_TIMEOUT_SECONDS", "8"))
# OpenRouter routes one model across many hosts whose time-to-first-token
# differs by tens of seconds. What the interface waits on is the first token,
# not tokens per second, so latency is the default ordering. Pin a host with
# MENTOR_PROVIDER_ORDER (comma separated, e.g. "baidu") when one is known good.
MENTOR_PROVIDER_ORDER = [
    slug.strip() for slug in os.environ.get("MENTOR_PROVIDER_ORDER", "").split(",")
    if slug.strip()
]
# Empty by default. Measured on this project, asking OpenRouter to sort by
# latency routed to hosts that answered more slowly and returned output the
# schema rejected — worse than its own default balancing. Pin a host you have
# actually measured instead of asking for a generic "fast" one.
MENTOR_PROVIDER_SORT = os.environ.get("MENTOR_PROVIDER_SORT", "").strip()
# Keep fallbacks on: a pinned host that is down must not end the session.
MENTOR_PROVIDER_ALLOW_FALLBACKS = os.environ.get(
    "MENTOR_PROVIDER_ALLOW_FALLBACKS", "true").lower() not in {"0", "false", "no"}
MENTOR_READ_TIMEOUT_SECONDS = float(os.environ.get(
    "MENTOR_READ_TIMEOUT_SECONDS", str(MENTOR_TIMEOUT_SECONDS)))
MENTOR_MAX_OUTPUT_TOKENS = int(os.environ.get("MENTOR_MAX_OUTPUT_TOKENS", "1600"))
ANALYSIS_MAX_SECONDS = float(os.environ.get("ANALYSIS_MAX_SECONDS", "5"))

MAX_SCORE_BYTES = int(os.environ.get("MAX_SCORE_BYTES", str(10 * 1024 * 1024)))
MAX_MXL_EXPANDED_BYTES = int(os.environ.get("MAX_MXL_EXPANDED_BYTES", str(20 * 1024 * 1024)))
MAX_MIDI_BYTES = int(os.environ.get("MAX_MIDI_BYTES", str(10 * 1024 * 1024)))
MAX_PERFORMANCE_EVENTS = int(os.environ.get("MAX_PERFORMANCE_EVENTS", "50000"))
MAX_SCORE_NOTES = int(os.environ.get("MAX_SCORE_NOTES", "50000"))
MAX_SCORE_DURATION_SECONDS = int(os.environ.get("MAX_SCORE_DURATION_SECONDS", str(2 * 60 * 60)))
MAX_MEASURES = int(os.environ.get("MAX_MEASURES", "200"))
ABANDONED_SESSION_HOURS = int(os.environ.get("ABANDONED_SESSION_HOURS", "24"))
GENERATED_RETENTION_HOURS = int(os.environ.get("GENERATED_RETENTION_HOURS", str(7 * 24)))
LOCAL_PROFILE_ID = "local"
# Bump when the importer changes what it derives from the same file, so builtin
# fixtures are re-ingested on machines that already ran an older build.
SCORE_IMPORTER_VERSION = "2026.08.11-title-fallback"

if MENTOR_RESPONSE_MODE not in {"json_schema", "json_object", "prompt_json"}:
    raise ValueError("MENTOR_RESPONSE_MODE must be json_schema, json_object, or prompt_json")
if MENTOR_REASONING_EFFORT not in {
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
}:
    raise ValueError("MENTOR_REASONING_EFFORT is not a supported reasoning level")

for d in (DATA_DIR, FILE_STORAGE_DIR, SCORE_STORAGE_DIR, SESSION_STORAGE_DIR,
          GENERATED_STORAGE_DIR):
    d.mkdir(parents=True, exist_ok=True)
