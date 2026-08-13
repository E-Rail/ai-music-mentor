#!/usr/bin/env bash
# Stop the local AI Music Mentor server.
#
# Only processes belonging to *this* checkout are touched. The launcher runs
# uvicorn out of the project's own .venv, so the project path is right there in
# the command line — which is what lets this tell our server on port 8000 apart
# from somebody else's, and refuse to kill theirs.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The port the launcher serves on, and the dev server a developer may also have
# running. Override with QUIT_PORTS="8000 5173 4173".
PORTS="${QUIT_PORTS:-8000 5173}"
# How long a process gets to shut down on its own before it is forced.
GRACE_SECONDS="${QUIT_GRACE_SECONDS:-8}"

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to find the running server." >&2
  exit 1
fi

# Does this process belong to this checkout?
#
# Two signals, because one is not enough. The launcher runs an absolute
# .venv/bin/python so the path is in its command line — but the same server
# started by hand from the project directory shows only "\.venv/bin/python",
# and matching that alone would miss it. A process whose working directory is
# inside the project is ours regardless of how it was spelled on the way in.
belongs_to_project() {
  local pid="$1" command cwd
  command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [[ "$command" == *"$PROJECT_DIR"* ]] && return 0
  cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | grep '^n' | head -1)"
  cwd="${cwd#n}"
  [[ -n "$cwd" && "$cwd" == "$PROJECT_DIR"* ]]
}

# PIDs listening on a port that were started from this checkout.
ours_on_port() {
  local port="$1" pid
  for pid in $(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true); do
    # Someone else's server on the same port is not ours to stop.
    if belongs_to_project "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
}

describe() {
  local pid="$1"
  ps -o command= -p "$pid" 2>/dev/null | cut -c1-72
}

stopped=0
skipped=0

for port in $PORTS; do
  # A port with something on it that is not ours is worth saying out loud,
  # because it explains why launch.sh may still find the port busy.
  for pid in $(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true); do
    if ! belongs_to_project "$pid"; then
      what="something else"
      # The same app served out of a different folder. Named rather than
      # stopped: another checkout is somebody else's session.
      if [[ "$(describe "$pid")" == *"app.main:app"* ]]; then
        what="an AI Music Mentor server from another folder"
      fi
      printf '  port %s is held by %s, left alone: %s\n' \
        "$port" "$what" "$(describe "$pid" | cut -c1-56)"
      skipped=$((skipped + 1))
    fi
  done

  for pid in $(ours_on_port "$port"); do
    printf '  stopping %s (pid %s)\n' "$(describe "$pid")" "$pid"
    kill "$pid" 2>/dev/null || true
    stopped=$((stopped + 1))
  done
done

if (( stopped == 0 )); then
  if (( skipped == 0 )); then
    echo "AI Music Mentor is not running."
  fi
  exit 0
fi

# Give them the grace period to close their sockets and flush, then insist.
deadline=$(( SECONDS + GRACE_SECONDS ))
while (( SECONDS < deadline )); do
  remaining=0
  for port in $PORTS; do
    for _ in $(ours_on_port "$port"); do remaining=$((remaining + 1)); done
  done
  if (( remaining == 0 )); then
    echo "Stopped."
    exit 0
  fi
  sleep 0.4
done

for port in $PORTS; do
  for pid in $(ours_on_port "$port"); do
    printf '  %s did not stop in %ss, forcing\n' "$pid" "$GRACE_SECONDS"
    kill -9 "$pid" 2>/dev/null || true
  done
done

echo "Stopped."
