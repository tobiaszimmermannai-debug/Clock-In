#!/usr/bin/env bash
# Startet Clipper mit einem Befehl:  ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v ffmpeg >/dev/null || { echo "ffmpeg fehlt → brew install ffmpeg"; exit 1; }

PY=""
for c in python3.12 python3.13 python3.11 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Python ≥ 3.11 fehlt → brew install python@3.12"; exit 1; }

if [ ! -d .venv ]; then
  echo "→ Lege virtuelle Umgebung an …"
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

STAMP=.venv/.requirements.sha
SUM=$(shasum requirements.txt | cut -d' ' -f1)
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$SUM" ]; then
  echo "→ Installiere Python-Pakete …"
  pip install -q --upgrade pip
  pip install -q -r requirements.txt
  echo "$SUM" > "$STAMP"
fi

[ -f .env ] || { cp .env.example .env; echo "→ .env aus .env.example angelegt (Zugangsdaten bei Bedarf eintragen)."; }

PORT=$(python -c 'from clipper.config import CFG; print(CFG["server"]["port"])')
( sleep 3; command -v open >/dev/null && open "http://localhost:$PORT" ) >/dev/null 2>&1 &
echo "→ Clipper läuft auf http://localhost:$PORT  (Beenden mit Ctrl+C)"
exec python -m clipper
