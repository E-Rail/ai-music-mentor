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
# The mentor explains numbers that are already computed; it is not solving
# anything. Private deliberation therefore buys nothing and costs twice — once
# generating tokens nobody reads, and again when they crowd the answer out of
# the ceiling and a truncated reply has to be re-asked. Measured on the same
# host, dropping from "low" to none took time-to-first-token from 7.0s to 1.3s.
# Models that cannot switch it off (gpt-oss) reject "none"; give them "low".
MENTOR_REASONING_EFFORT = os.environ.get("MENTOR_REASONING_EFFORT", "none").lower()
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
# A pinned host is only a preference while fallbacks are on, and OpenRouter
# routes past it freely: with MENTOR_PROVIDER_ORDER=baidu set, measured calls
# came back from StreamLake and DigitalOcean and took three times as long. So
# naming a host now means it — pinning and hoping is not a latency guarantee.
# Set MENTOR_PROVIDER_ALLOW_FALLBACKS=true to go back to preferring rather than
# pinning; with no host named, fallbacks stay on either way. None means unset,
# and the adapter answers it from the order it sees — deciding here would freeze
# the answer at import against whatever the order happened to be then.
_ALLOW_FALLBACKS_ENV = os.environ.get("MENTOR_PROVIDER_ALLOW_FALLBACKS", "").lower()
MENTOR_PROVIDER_ALLOW_FALLBACKS: bool | None = (
    None if not _ALLOW_FALLBACKS_ENV
    else _ALLOW_FALLBACKS_ENV not in {"0", "false", "no"})
MENTOR_READ_TIMEOUT_SECONDS = float(os.environ.get(
    "MENTOR_READ_TIMEOUT_SECONDS", str(MENTOR_TIMEOUT_SECONDS)))
MENTOR_MAX_OUTPUT_TOKENS = int(os.environ.get("MENTOR_MAX_OUTPUT_TOKENS", "4000"))
# With reasoning on, a model's private deliberation is charged against the same
# ceiling as its answer, so a long think returns half a JSON object. Measured
# here: an exercise plan hit the 1600 ceiling, failed to parse, retried
# identically, and cost 136 seconds before falling back. The adapter widens the
# ceiling once when it sees a truncated answer; this is how far it may go.
MENTOR_MAX_OUTPUT_TOKENS_CEILING = int(os.environ.get(
    "MENTOR_MAX_OUTPUT_TOKENS_CEILING", "6000"))
ANALYSIS_MAX_SECONDS = float(os.environ.get("ANALYSIS_MAX_SECONDS", "5"))

# ---------------------------------------------------------------- reading a page
# Turning a photographed or printed page into notes. This is the one job in the
# app where a model reads the source material rather than explaining measured
# facts, so it is configured separately from the mentor and can be pointed at a
# different model without touching coaching. It reuses the mentor's credentials
# because both speak the same OpenAI-compatible API.
VISION_API_BASE = os.environ.get("VISION_API_BASE", MENTOR_API_BASE).rstrip("/")
VISION_API_KEY = os.environ.get("VISION_API_KEY", MENTOR_API_KEY)
VISION_MODEL = os.environ.get("VISION_MODEL", "xiaomi/mimo-v2.5")
# Reading a page is slower than explaining a report, and it happens once per
# import rather than once per take, so it is allowed to take longer.
VISION_TIMEOUT_SECONDS = float(os.environ.get("VISION_TIMEOUT_SECONDS", "180"))
VISION_CONNECT_TIMEOUT_SECONDS = float(os.environ.get(
    "VISION_CONNECT_TIMEOUT_SECONDS", "10"))
VISION_MAX_OUTPUT_TOKENS = int(os.environ.get("VISION_MAX_OUTPUT_TOKENS", "12000"))
# One page is a demo; a whole sonata is not. Each extra page costs latency and
# another chance for the read to fail, so the limit is small and explicit.
VISION_MAX_PAGES = int(os.environ.get("VISION_MAX_PAGES", "2"))
# Long edge in pixels. Engraved staff lines survive downscaling; a phone photo
# at full size mostly costs upload time.
VISION_PAGE_PIXELS = int(os.environ.get("VISION_PAGE_PIXELS", "1600"))
MAX_SCORE_IMAGE_BYTES = int(os.environ.get(
    "MAX_SCORE_IMAGE_BYTES", str(25 * 1024 * 1024)))

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
SCORE_IMPORTER_VERSION = "2026.08.12-measure-labels"

if MENTOR_RESPONSE_MODE not in {"json_schema", "json_object", "prompt_json"}:
    raise ValueError("MENTOR_RESPONSE_MODE must be json_schema, json_object, or prompt_json")
if MENTOR_REASONING_EFFORT not in {
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
}:
    raise ValueError("MENTOR_REASONING_EFFORT is not a supported reasoning level")

for d in (DATA_DIR, FILE_STORAGE_DIR, SCORE_STORAGE_DIR, SESSION_STORAGE_DIR,
          GENERATED_STORAGE_DIR):
    d.mkdir(parents=True, exist_ok=True)
