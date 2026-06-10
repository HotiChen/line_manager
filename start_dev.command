#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# LINE Bot 管理平台 — 本地開發啟動腳本 (含 Mock Backend)
# 1) Mock API backend  →  http://localhost:8787
# 2) Frontend server   →  http://localhost:5500
# 3) 自動開啟 Chrome
# ─────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")"

echo "🚀 LINE Bot Management Platform - Local Dev"
echo "============================================"

# Kill any existing processes on these ports
lsof -ti:8787 | xargs kill -9 2>/dev/null
lsof -ti:5500 | xargs kill -9 2>/dev/null
sleep 1

# Start mock backend on port 8787
echo "⚙️  Starting Mock Backend (port 8787)..."
node mock_server.js &
BACKEND_PID=$!
sleep 1

# Start frontend HTTP server on port 5500
echo "📦 Starting Frontend Server (port 5500)..."
python3 -m http.server 5500 --bind 127.0.0.1 &
FRONTEND_PID=$!
sleep 1

echo ""
echo "✅ Mock Backend  →  http://localhost:8787"
echo "✅ Frontend      →  http://localhost:5500"
echo ""
echo "🌐 Opening in Chrome..."

# Open Chrome with test userId pre-set via URL param
open -a "Google Chrome" "http://localhost:5500/index.html?userId=U_demo_user_001"

echo ""
echo "Press Ctrl+C to stop all servers."
echo "============================================"

# Wait for Ctrl+C then cleanup
trap "echo ''; echo '🛑 Stopping servers...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
