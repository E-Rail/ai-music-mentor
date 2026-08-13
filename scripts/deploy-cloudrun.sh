#!/usr/bin/env bash
# Publish the studio to Google Cloud Run, which builds the Dockerfile and serves
# it over HTTPS.
#
# HTTPS is not a nicety here: the microphone and the MIDI keyboard are both
# behind browser permissions that a plain http:// page is never granted, so a
# host that terminates TLS for you is the difference between a working demo and
# a page that cannot hear anything.
#
#   scripts/deploy-cloudrun.sh [project-id]
#
# Run it again to deploy again — Cloud Run keeps the address and swaps in the
# new revision, so a link you have already shared keeps working.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

SERVICE="${SERVICE:-ai-music-mentor}"
REGION="${REGION:-us-central1}"
PROJECT="${1:-${GCP_PROJECT:-}}"

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n%s\n' "$*"; }

# --- what we need before touching anything -----------------------------------

command -v gcloud >/dev/null || die "The Google Cloud CLI is not installed.
       macOS:  brew install --cask google-cloud-sdk
       or:     https://cloud.google.com/sdk/docs/install"
command -v python3 >/dev/null || die "python3 is required (it writes the settings file)."

account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
[[ -n "$account" ]] || die "Not signed in yet. Run this first, then re-run:
       gcloud auth login"

if [[ -z "$PROJECT" ]]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null)"
  [[ -n "$PROJECT" && "$PROJECT" != "(unset)" ]] || die \
    "No project chosen. Pass one, or set a default:
       scripts/deploy-cloudrun.sh my-project-id
       gcloud config set project my-project-id

     Create one at https://console.cloud.google.com/projectcreate — billing has
     to be enabled on it, even though this stays inside the free allowance."
fi

step "Signed in as $account, deploying to project $PROJECT ($REGION)."

# --- the services this needs -------------------------------------------------

# Enabling an API that is already on is a no-op, so this is safe to repeat and
# saves a first-time deploy failing halfway with a permissions error.
step "Making sure Cloud Run, Cloud Build and Artifact Registry are on…"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  --project "$PROJECT" 2>&1 | sed 's/^/  /'

# --- settings ----------------------------------------------------------------

# Written as YAML rather than passed with --set-env-vars, which splits on commas
# and would cut MENTOR_PROVIDER_ORDER=cerebras,groq in half.
#
# The file is built outside the repository and removed on the way out, so the
# key is never sitting in the working tree waiting to be committed.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
env_args=()

if [[ -f .env ]]; then
  python3 - "$tmp/env.yaml" <<'PY'
import sys, pathlib
out, seen = {}, []
for raw in pathlib.Path(".env").read_text(encoding="utf-8").splitlines():
    line = raw.strip().lstrip("﻿")
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key, value = key.strip(), value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    if not value:
        continue
    out[key] = value
    seen.append(key)
# yaml.safe_dump is not available without a dependency, and these are flat
# scalars, so quote them the one way YAML always accepts.
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    for key in seen:
        fh.write('%s: "%s"\n' % (key, out[key].replace("\\", "\\\\").replace('"', '\\"')))
print("  %d settings from .env" % len(seen))
for key in seen:
    secret = key.endswith(("_KEY", "_TOKEN", "_SECRET", "_PASSWORD"))
    print("    %-34s %s" % (key, "<redacted>" if secret else out[key]))
PY
  env_args=(--env-vars-file "$tmp/env.yaml")
else
  printf '\n  No .env found. The studio will still listen, diagnose and build\n'
  printf '  exercises; it just falls back to its own wording instead of the\n'
  printf '  mentor model'"'"'s.\n'
fi

# --- deploy ------------------------------------------------------------------

# --max-instances 1 is not a cost control, it is a correctness one. The database
# lives in the container, so a second instance would be a second, empty history
# that some students would land on and others would not.
#
# --timeout has to outlast the score reader, which is allowed 180s to read a
# photographed page; the default 300 covers it with room to spare.
step "Building and deploying — the first run takes about 10 minutes…"
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8000 \
  --memory 1Gi \
  --cpu 1 \
  --timeout 300 \
  --max-instances 1 \
  "${env_args[@]}" 2>&1 | sed 's/^/  /'

url="$(gcloud run services describe "$SERVICE" --project "$PROJECT" \
  --region "$REGION" --format='value(status.url)' 2>/dev/null)"

cat <<DONE

Deployed.

  Live at   ${url:-check the console}
  Console   https://console.cloud.google.com/run/detail/$REGION/$SERVICE?project=$PROJECT

Open it in Chrome or Edge. The MIDI keyboard needs Web MIDI, which Safari and
Firefox do not have.

It scales to zero when nobody is using it, so the first visit after a quiet
spell waits a few seconds for the container to start. Open it once before you
present and it will be warm.
DONE
