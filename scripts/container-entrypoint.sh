#!/bin/sh
set -eu

cd /app/apps/api

# CloudStudio (and most PaaS) inject a PORT env var; fall back to 8000 locally.
export PORT="${PORT:-8000}"
export HOST="${HOST:-0.0.0.0}"

alembic upgrade head
exec uvicorn app.main:app --host "$HOST" --port "$PORT"
