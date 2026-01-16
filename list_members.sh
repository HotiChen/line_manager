#!/bin/bash

# 查看團隊成員列表
API_BASE="http://localhost:8787"
USER_ID="Ud66f9caf44c4d927ca4f9361d66ccc18"

echo "🔍 查詢團隊成員列表..."
echo ""

curl -s "${API_BASE}/team/members" \
  -H "X-User-Id: ${USER_ID}" | jq '.'

echo ""
echo "✅ 查詢完成"
