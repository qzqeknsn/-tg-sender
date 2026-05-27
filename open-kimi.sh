#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  Рабочая панель: web/"
echo "  http://127.0.0.1:8000"
echo ""
exec ./run-web.sh
