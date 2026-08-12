#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$PROJECT_DIR/apps/web"
API_DIR="$PROJECT_DIR/apps/api"

# Finder-launched .command files do not always inherit Homebrew or /usr/local.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

build_web() {
  cd "$WEB_DIR"

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required. Install Node.js, then run launch.sh again."
    exit 1
  fi

  local needs_install=false
  if [[ ! -x node_modules/.bin/tsc || ! -x node_modules/.bin/vite ||
        ! -f node_modules/.modules.yaml ]]; then
    needs_install=true
  elif [[ pnpm-lock.yaml -nt node_modules/.modules.yaml ]]; then
    needs_install=true
  fi

  if [[ "$needs_install" == true ]]; then

    local -a package_manager
    if command -v pnpm >/dev/null 2>&1; then
      package_manager=(pnpm)
    elif command -v corepack >/dev/null 2>&1; then
      export COREPACK_HOME="$PROJECT_DIR/data/corepack"
      mkdir -p "$COREPACK_HOME"
      package_manager=(corepack pnpm)
    elif command -v npx >/dev/null 2>&1; then
      package_manager=(npx --yes pnpm@11.21.0)
    else
      echo "pnpm/Corepack is unavailable. Reinstall a current Node.js release."
      exit 1
    fi

    echo "Installing web dependencies for the first launch…"
    CI=true "${package_manager[@]}" install --frozen-lockfile
  fi

  # Use the project-local executables. This avoids requiring a global pnpm
  # command after dependencies have already been installed.
  node scripts/copy-basic-pitch-assets.mjs
  node_modules/.bin/tsc -b
  node_modules/.bin/vite build
}

find_python() {
  local venv_python="$PROJECT_DIR/.venv/bin/python"
  if [[ -x "$venv_python" ]] &&
     "$venv_python" -c 'import alembic, defusedxml, dotenv, fastapi, httpx, mido, music21, multipart, numpy, pydantic, sqlalchemy, uvicorn' >/dev/null 2>&1; then
    printf '%s\n' "$venv_python"
    return 0
  fi

  local candidate
  local base_python=""
  if command -v python >/dev/null 2>&1; then
    base_python="$(command -v python)"
  elif command -v python3 >/dev/null 2>&1; then
    base_python="$(command -v python3)"
  else
    echo "Python 3 is required. Install Python, then run launch.sh again." >&2
    return 1
  fi

  if [[ ! -x "$venv_python" ]]; then
    echo "Creating a local Python environment…" >&2
    "$base_python" -m venv "$PROJECT_DIR/.venv"
  fi
  echo "Installing API dependencies for the first launch…" >&2
  "$venv_python" -m pip install -r "$API_DIR/requirements.txt" >&2
  printf '%s\n' "$venv_python"
}

build_web
API_PYTHON="$(find_python)"

cd "$API_DIR"
"$API_PYTHON" -m alembic upgrade head
exec "$API_PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
