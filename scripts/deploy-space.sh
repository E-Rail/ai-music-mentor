#!/usr/bin/env bash
# Publish the studio to a Hugging Face Space, which builds the Dockerfile and
# serves it over HTTPS.
#
# Hugging Face only gives *static* Spaces away now — a Docker Space on free
# cpu-basic is refused at creation unless the account has PRO. Without one, use
# deploy-cloudrun.sh, which builds the same image from the same Dockerfile.
#
# HTTPS is not a nicety here: the microphone and the MIDI keyboard are both
# behind browser permissions that a plain http:// page is never granted, so a
# host that terminates TLS for you is the difference between a working demo and
# a page that cannot hear anything.
#
#   scripts/deploy-space.sh <owner>/<space-name>
#
# Run it again to deploy again — it force-pushes, so the Space always matches
# the commit you have checked out.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

SPACE="${1:-${HF_SPACE:-}}"
SPACE_CARD="deploy/huggingface/README.md"
API="https://huggingface.co/api"

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n%s\n' "$*"; }

# --- what we need before touching anything -----------------------------------

[[ -n "$SPACE" ]] || die "Usage: scripts/deploy-space.sh <owner>/<space-name>
       e.g. scripts/deploy-space.sh $(git config user.name 2>/dev/null || echo your-name)/ai-music-mentor"
[[ "$SPACE" == */* && "$SPACE" != */*/* ]] || die "A Space is named <owner>/<space-name>, got: $SPACE"
[[ -f "$SPACE_CARD" ]] || die "Missing $SPACE_CARD — it carries the Space's sdk and port settings."
command -v curl >/dev/null || die "curl is required."
command -v python3 >/dev/null || die "python3 is required (it builds the JSON this sends)."
OWNER="${SPACE%%/*}"
NAME="${SPACE##*/}"

# The tree that gets pushed is HEAD's, not the working directory's. Saying so
# now is kinder than letting someone deploy and wonder why their edit is missing.
if ! git diff --quiet HEAD 2>/dev/null; then
  printf '\n  Uncommitted changes will NOT be deployed — the Space gets commit %s.\n' \
    "$(git rev-parse --short HEAD)"
  read -r -p "  Continue anyway? [y/N] " reply
  [[ "$reply" == [yY]* ]] || die "Nothing deployed. Commit first, then re-run."
fi

if [[ -z "${HF_TOKEN:-}" ]]; then
  printf '\n  A Hugging Face access token with **write** permission is needed.\n'
  printf '  Create one at https://huggingface.co/settings/tokens\n\n'
  read -r -s -p "  Token (input hidden): " HF_TOKEN
  printf '\n'
fi
[[ -n "$HF_TOKEN" ]] || die "No token given."

auth=(-H "Authorization: Bearer $HF_TOKEN")

whoami_json="$(curl -sf "${auth[@]}" "$API/whoami-v2" || true)"
[[ -n "$whoami_json" ]] || die "That token was rejected. Check it has write permission."
# Parsed rather than grepped: the reply also lists every org you belong to, each
# with its own "name", and a regex reaches for the wrong one.
HF_USER="$(printf '%s' "$whoami_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("name",""))')"
[[ -n "$HF_USER" ]] || die "Could not read the account name from Hugging Face."
step "Signed in as $HF_USER."

# --- create the Space if it is not there yet ---------------------------------

if curl -sf -o /dev/null "${auth[@]}" "$API/spaces/$SPACE"; then
  step "Space $SPACE already exists — updating it."
else
  step "Creating Space ${SPACE}…"
  payload="{\"type\":\"space\",\"name\":\"$NAME\",\"sdk\":\"docker\",\"private\":false"
  # Only send organization when the owner is not the account itself; sending
  # your own username as an org is rejected.
  [[ "$OWNER" != "$HF_USER" ]] && payload="$payload,\"organization\":\"$OWNER\""
  payload="$payload}"
  created="$(curl -s -X POST "${auth[@]}" -H "Content-Type: application/json" \
    -d "$payload" "$API/repos/create")"
  printf '%s' "$created" | grep -q '"url"' \
    || die "Could not create the Space: $created"
fi

# --- build the commit to push ------------------------------------------------

# The Space needs its settings in a root README.md, and this project's own
# README is a different document for a different reader. So the card is swapped
# in over here, in a scratch index, leaving the checkout untouched.
#
# The commit is deliberately parentless. The Space is a deployment target rather
# than a mirror, and an orphan commit means nothing from this repository's past
# — including anything ever committed by mistake — travels to a public page.
step "Assembling the deployment from $(git rev-parse --short HEAD)…"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

GIT_INDEX_FILE="$tmp/index" git read-tree HEAD
blob="$(git hash-object -w -- "$SPACE_CARD")"
GIT_INDEX_FILE="$tmp/index" git update-index --add --cacheinfo "100644,$blob,README.md"
tree="$(GIT_INDEX_FILE="$tmp/index" git write-tree)"
commit="$(git commit-tree "$tree" -m "Deploy $(git rev-parse --short HEAD)

$(git log -1 --pretty=%s)")"

# --- push --------------------------------------------------------------------

# Passed through askpass rather than embedded in the remote URL, which would put
# the token in this machine's process list for anyone running `ps`.
askpass="$tmp/askpass"
cat > "$askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\n' "$HF_ASKPASS_USER" ;;
  *) printf '%s\n' "$HF_ASKPASS_TOKEN" ;;
esac
ASKPASS
chmod +x "$askpass"

step "Pushing to huggingface.co/spaces/${SPACE}…"
HF_ASKPASS_USER="$HF_USER" HF_ASKPASS_TOKEN="$HF_TOKEN" \
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
  git push --force "https://huggingface.co/spaces/$SPACE" "$commit:refs/heads/main" 2>&1 \
  | sed 's/^/  /'

# --- settings ----------------------------------------------------------------

# Config the app reads at start-up. Without the mentor credential the studio
# still listens, still diagnoses and still builds exercises — it just falls back
# to its own wording instead of the model's, so this is worth getting right.
if [[ -f .env ]]; then
  printf '\n  .env holds the settings the mentor and the score reader need.\n'
  printf '  Sending them to the Space stores the key in Hugging Face'"'"'s secret store,\n'
  printf '  where only this Space can read it. Skip this and set them by hand at\n'
  printf '  https://huggingface.co/spaces/%s/settings\n\n' "$SPACE"
  read -r -p "  Send settings from .env to the Space? [y/N] " reply
  if [[ "$reply" == [yY]* ]]; then
    sent=0
    # Read on fd 3 so the loop body is free to use stdin, and strip the carriage
    # return a .env written on Windows leaves on the end of every value.
    while IFS= read -r line <&3 || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ "$line" =~ ^[[:space:]]*# || -z "${line// }" ]] && continue
      [[ "$line" == *=* ]] || continue
      key="${line%%=*}"; key="${key//[[:space:]]/}"
      value="${line#*=}"
      # A quoted value is quoted for the shell's benefit, not the server's.
      [[ "$value" == \"*\" || "$value" == \'*\' ]] && value="${value:1:${#value}-2}"
      [[ -n "$value" ]] || continue
      # Anything that names itself a credential goes to the secret store, which
      # is write-only; everything else is ordinary config and stays readable so
      # it can be checked without a round trip through this script.
      kind="variables"
      case "$key" in *_KEY|*_TOKEN|*_SECRET|*_PASSWORD) kind="secrets" ;; esac
      body="$(python3 -c 'import json,sys; print(json.dumps({"key":sys.argv[1],"value":sys.argv[2]}))' \
        "$key" "$value")"
      if curl -sf -o /dev/null -X POST "${auth[@]}" -H "Content-Type: application/json" \
          -d "$body" "$API/spaces/$SPACE/$kind"; then
        printf '  set %-32s → %s\n' "$key" "$kind"
        sent=$((sent + 1))
      else
        printf '  could not set %s\n' "$key" >&2
      fi
    done 3< .env
    printf '\n  %s settings sent.\n' "$sent"
  fi
fi

# The served subdomain is the owner and name lowercased with everything that is
# not a letter or digit turned into a dash — not the Space id as typed.
slug="$(printf '%s-%s' "$OWNER" "$NAME" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')"

cat <<DONE

Deployed.

  Building   https://huggingface.co/spaces/$SPACE
  Live at    https://$slug.hf.space

The first build takes roughly 5-10 minutes: it installs the API's dependencies
and downloads the 60 MB listening model so students never have to. Watch the
Logs tab; the page is up when the Space shows "Running".

Open it in Chrome or Edge. The MIDI keyboard needs Web MIDI, which Safari and
Firefox do not have.
DONE
