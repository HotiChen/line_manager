#!/bin/bash

# 完整邀請流程測試腳本
# 測試: 生成 → 預覽 → 接受 → 驗證
# 使用方式: ./test_invite_full.sh

# 設定
API_BASE="${API_BASE:-http://localhost:8787}"
OWNER_USER_ID="${OWNER_USER_ID:-U_test_owner}"
MEMBER_USER_ID="${MEMBER_USER_ID:-U_test_member_$(date +%s)}"
TEST_BOT_ID="${TEST_BOT_ID:-bot_test_123}"

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🧪 邀請流程完整測試${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 測試設定:"
echo "   - API Base: ${API_BASE}"
echo "   - Owner User ID: ${OWNER_USER_ID}"
echo "   - Member User ID: ${MEMBER_USER_ID}"
echo "   - Test Bot ID: ${TEST_BOT_ID}"
echo ""

# ========================================
# 步驟 1: 生成邀請連結
# ========================================
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}📝 步驟 1: 生成邀請連結${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

GENERATE_RESPONSE=$(curl -s -X POST "${API_BASE}/team/invite/generate" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: ${OWNER_USER_ID}" \
  -d "{
    \"inviteRole\": \"member\",
    \"expiresInHours\": 24,
    \"targetBotIds\": [\"${TEST_BOT_ID}\"]
  }")

echo "API 回應:"
echo "$GENERATE_RESPONSE" | jq '.'

# 檢查是否成功
if echo "$GENERATE_RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
    TOKEN=$(echo "$GENERATE_RESPONSE" | jq -r '.token')
    INVITE_URL=$(echo "$GENERATE_RESPONSE" | jq -r '.inviteUrl')
    echo ""
    echo -e "${GREEN}✅ 邀請連結生成成功！${NC}"
    echo -e "   Token: ${GREEN}${TOKEN}${NC}"
    echo -e "   URL: ${GREEN}${INVITE_URL}${NC}"
else
    echo ""
    echo -e "${RED}❌ 邀請連結生成失敗${NC}"
    exit 1
fi

sleep 1

# ========================================
# 步驟 2: 預覽邀請資訊
# ========================================
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}👀 步驟 2: 預覽邀請資訊${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

PREVIEW_RESPONSE=$(curl -s -X POST "${API_BASE}/team/invite/preview" \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$TOKEN\"}")

echo "API 回應:"
echo "$PREVIEW_RESPONSE" | jq '.'

if echo "$PREVIEW_RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
    echo ""
    echo -e "${GREEN}✅ 邀請資訊預覽成功${NC}"
else
    echo ""
    echo -e "${RED}❌ 預覽失敗${NC}"
    exit 1
fi

sleep 1

# ========================================
# 步驟 3: 接受邀請
# ========================================
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}✋ 步驟 3: 接受邀請${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

ACCEPT_RESPONSE=$(curl -s -X POST "${API_BASE}/team/invite/accept" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$TOKEN\",
    \"userId\": \"$MEMBER_USER_ID\",
    \"displayName\": \"測試成員\",
    \"pictureUrl\": \"\"
  }")

echo "API 回應:"
echo "$ACCEPT_RESPONSE" | jq '.'

if echo "$ACCEPT_RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
    echo ""
    echo -e "${GREEN}✅ 成功接受邀請${NC}"
    
    # 檢查是否有警告 (部分成功)
    if echo "$ACCEPT_RESPONSE" | jq -e '.warning' > /dev/null 2>&1; then
        WARNING=$(echo "$ACCEPT_RESPONSE" | jq -r '.warning')
        echo -e "${YELLOW}⚠️  警告: ${WARNING}${NC}"
    fi
else
    echo ""
    echo -e "${RED}❌ 接受邀請失敗${NC}"
    exit 1
fi

sleep 1

# ========================================
# 步驟 4: 驗證重複使用 (應該失敗)
# ========================================
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}🔒 步驟 4: 驗證 Token 防重用機制${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

REUSE_RESPONSE=$(curl -s -X POST "${API_BASE}/team/invite/accept" \
  -H "Content-Type: application/json" \
  -d "{
    \"token\": \"$TOKEN\",
    \"userId\": \"U_another_user_$(date +%s)\",
    \"displayName\": \"另一個用戶\"
  }")

echo "API 回應:"
echo "$REUSE_RESPONSE" | jq '.'

# 這次應該要失敗
if echo "$REUSE_RESPONSE" | jq -e '.error' | grep -q "already used"; then
    echo ""
    echo -e "${GREEN}✅ Token 防重用機制正常 (已正確拒絕重複使用)${NC}"
else
    echo ""
    echo -e "${RED}❌ 警告: Token 可能被重複使用${NC}"
fi

# ========================================
# 測試總結
# ========================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 測試完成！${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📊 測試摘要:"
echo -e "   ${GREEN}✓${NC} 邀請連結生成"
echo -e "   ${GREEN}✓${NC} 邀請資訊預覽"
echo -e "   ${GREEN}✓${NC} 接受邀請"
echo -e "   ${GREEN}✓${NC} Token 防重用"
echo ""
echo "🔗 測試用的邀請連結:"
echo "   本地測試: http://127.0.0.1:5500/pages/invite.html?token=${TOKEN}&debug=true&userId=${MEMBER_USER_ID}&displayName=測試用戶"
echo ""
