#!/usr/bin/env bash
# GateKeepr - start script (macOS / Linux)
set -euo pipefail
cd "$(dirname "$0")"

[ -f ../papers.csv ] || cp ../examples/papers.example.csv ../papers.csv
[ -f ../criteria.json ] || cp ../examples/criteria.example.json ../criteria.json
mkdir -p ../pdfs ../data

if [ ! -x .venv/bin/python ]; then
  echo "[setup] Creating Python virtual environment..."
  python3 -m venv .venv
fi
if [ ! -f .venv/.deps-installed ]; then
  echo "[setup] Installing Python dependencies..."
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
  touch .venv/.deps-installed
fi
command -v node >/dev/null 2>&1 || export PATH="$PWD/.venv/bin:$PATH"
if [ ! -f frontend/dist/index.html ]; then
  echo "[setup] Building the web interface..."
  (cd frontend && npm install --no-audit --no-fund && npm run build)
fi
PORT="${SCREENING_PORT:-8765}"
echo
echo " GateKeepr is starting on http://127.0.0.1:${PORT}  (Ctrl+C to stop)"
echo
( sleep 3; (command -v open >/dev/null && open "http://127.0.0.1:${PORT}") || (command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:${PORT}") || true ) &
exec .venv/bin/python -m backend.server
