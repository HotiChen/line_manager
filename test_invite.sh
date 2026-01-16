#!/bin/bash

# 測試邀請連結生成腳本
# 使用方式: ./test_invite.sh

API_BASE="https://pinti-line-dev.timchen-80f.workers.dev"
USER_ID="Ud66f9caf44c4d927ca4f9361d66ccc18"  # 您的測試用戶 ID

echo "🔧 正在生成測試邀請連結..."
echo ""

# 生成邀請連結
RESPONSE=$(curl -s -X POST "${API_BASE}/team/invite/generate" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: ${USER_ID}" \
  -d '{
    "inviteRole": "member",
    "expiresInHours": 24
  }')

echo "📋 API 回應："
echo "$RESPONSE" | jq '.'

echo ""
echo "✅ 測試用邀請連結："
INVITE_URL=$(echo "$RESPONSE" | jq -r '.inviteUrl')
echo "$INVITE_URL"

echo ""
echo "🔗 本地測試連結："
TOKEN=$(echo "$RESPONSE" | jq -r '.token')
echo "http://127.0.0.1:5500/pages/invite.html?token=${TOKEN}"
