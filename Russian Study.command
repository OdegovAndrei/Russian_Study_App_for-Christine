#!/bin/bash
# Launches Russian Study on macOS: creates the Python environment on first run,
# starts the local server and opens the browser.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${1:-5174}"
if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
  echo "Укажи порт от 1 до 65535, например: bash 'Russian Study.command' 5175" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  echo "Нужен Python 3.9 или новее (python.org). Установи его и запусти файл снова." >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
fi

if ! .venv/bin/python -c 'import edge_tts' >/dev/null 2>&1; then
  echo "Устанавливаю озвучку (нужен интернет при первом запуске)…"
  .venv/bin/python -m pip install --quiet -r requirements.txt || \
    echo "Не удалось установить edge-tts: будет использоваться голос браузера."
fi

# Stop a previous copy of this server on the same port, if any.
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -t -n -P -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    if [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$PWD" ]; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
    fi
  done
fi

(sleep 1.5; open "http://localhost:$PORT/") &
echo "Russian Study: http://localhost:$PORT   (Ctrl+C — остановить)"
exec .venv/bin/python server.py "$PORT"
