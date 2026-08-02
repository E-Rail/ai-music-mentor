#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="http://127.0.0.1:8000"
READY_URL="$APP_URL/api/v1/readiness"

open_app() {
  if command -v open >/dev/null 2>&1; then
    open "$APP_URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$APP_URL"
  else
    printf 'AI Music Mentor is ready at %s\n' "$APP_URL"
  fi
}

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to run the local readiness check." >&2
  exit 1
fi

cd "$PROJECT_DIR"

if curl --silent --fail --max-time 1 "$READY_URL" >/dev/null 2>&1; then
  open_app
  exit 0
fi

bash "$PROJECT_DIR/scripts/start-local.sh" &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

for ((attempt = 1; attempt <= 1200; attempt++)); do
  if curl --silent --fail --max-time 1 "$READY_URL" >/dev/null 2>&1; then
    open_app
    wait "$SERVER_PID"
    exit $?
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.5
done

echo "AI Music Mentor did not become ready within 10 minutes." >&2
exit 1
