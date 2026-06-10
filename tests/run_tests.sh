#!/bin/bash
#
# 🔒 安全性修改測試 — 一鍵啟動
#
# 使用方式：
#   chmod +x run_tests.sh
#   ./run_tests.sh
#
# 可選：帶 migration secret
#   MIGRATION_SECRET=你的密碼 ./run_tests.sh
#

set -e

PORT=8787
API_BASE="http://localhost:$PORT"

echo ""
echo "🔒 Pinti LINE 安全性測試"
echo "========================"
echo ""

# 1. 檢查 node_modules
if [ ! -d "node_modules" ]; then
    echo "📦 安裝依賴..."
    npm install
fi

# 2. 檢查是否已有 wrangler 在跑
if curl -s "$API_BASE/debug-ping" 2>/dev/null | grep -q "success"; then
    echo "✅ Worker 已在 $API_BASE 運行"
    echo ""
    echo "🧪 開始執行測試..."
    echo ""
    node test_security.mjs
    exit $?
fi

# 3. 啟動 wrangler dev
echo "🚀 啟動 Wrangler Dev Server..."
echo "   (如果是第一次，可能需要登入 Cloudflare)"
echo ""

npx wrangler dev --env dev --port $PORT &
WRANGLER_PID=$!

# 等待啟動
echo "⏳ 等待 Worker 啟動..."
for i in $(seq 1 30); do
    if curl -s "$API_BASE/debug-ping" 2>/dev/null | grep -q "success"; then
        echo "✅ Worker 已啟動 (PID: $WRANGLER_PID)"
        echo ""
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Worker 啟動逾時，請手動檢查"
        kill $WRANGLER_PID 2>/dev/null
        exit 1
    fi
    sleep 1
done

# 4. 執行測試
echo "🧪 開始執行測試..."
echo ""
node test_security.mjs
TEST_EXIT=$?

# 5. 關閉 wrangler
echo ""
read -p "按 Enter 關閉 Worker，或 Ctrl+C 保持運行... " _
kill $WRANGLER_PID 2>/dev/null
echo "🛑 Worker 已關閉"

exit $TEST_EXIT
