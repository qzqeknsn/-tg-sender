#!/bin/bash
cd "$(dirname "$0")"
PORT=8000

# Освободить порт, если остался старый uvicorn
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "Останавливаю старый процесс на порту $PORT..."
  lsof -ti :$PORT | xargs kill -9 2>/dev/null
  sleep 1
fi

echo ""
echo "  ═══════════════════════════════════════"
echo "  Telegram Sender Pro — Демо (с API)"
echo ""
echo "  Открой в браузере:"
echo "    → http://localhost:$PORT/demo/"
echo "    → http://127.0.0.1:$PORT/demo/"
echo ""
echo "  Обычная панель: http://localhost:$PORT/"
echo "  ═══════════════════════════════════════"
echo ""
if [[ "$(uname)" == "Darwin" ]]; then
  (sleep 2 && open "http://127.0.0.1:$PORT/demo/") &
fi
exec ./venv/bin/uvicorn api_server:app --reload --host 127.0.0.1 --port $PORT
