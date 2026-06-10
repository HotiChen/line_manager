#!/bin/bash

API_URL="http://localhost:8787"
OWNER_ID="Ud66f9caf44c4d927ca4f9361d66ccc18"
NEW_USER_ID="U_new_member_001"
BOT_ID="U_bot_A" # Assuming this exists from migration/seed

echo "🚀 Starting Comprehensive API Test..."

# 1. List User Bots (Owner)
echo -e "\n1️⃣  Testing /user/bots (Owner)..."
curl -s -H "X-User-Id: $OWNER_ID" "$API_URL/user/bots" | grep "bots" && echo "✅ Success" || echo "❌ Failed"

# 2. List Team Members (Owner)
echo -e "\n2️⃣  Testing /team/members (Owner)..."
curl -s -H "X-User-Id: $OWNER_ID" "$API_URL/team/members" | grep "members" && echo "✅ Success" || echo "❌ Failed"

# 3. Generate Invite Link (Owner)
echo -e "\n3️⃣  Testing /team/invite/generate (Owner)..."
INVITE_RES=$(curl -s -X POST -H "Content-Type: application/json" -H "X-User-Id: $OWNER_ID" -d '{"inviteRole":"member"}' "$API_URL/team/invite/generate")
echo $INVITE_RES
TOKEN=$(echo $INVITE_RES | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

if [ -n "$TOKEN" ]; then
  echo "✅ Invite Token Generated: $TOKEN"
else
  echo "❌ Failed to generate token"
  exit 1
fi

# 4. Accept Invite (New User)
echo -e "\n4️⃣  Testing /team/invite/accept (New User)..."
ACCEPT_RES=$(curl -s -X POST -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\", \"userId\":\"$NEW_USER_ID\", \"displayName\":\"New Member\", \"pictureUrl\":\"http://example.com/pic.jpg\"}" "$API_URL/team/invite/accept")
echo $ACCEPT_RES | grep "success" && echo "✅ Success" || echo "❌ Failed"

# 5. Verify New Member in List
echo -e "\n5️⃣  Verifying New Member in List..."
curl -s -H "X-User-Id: $OWNER_ID" "$API_URL/team/members" | grep "$NEW_USER_ID" && echo "✅ Member Found" || echo "❌ Member Not Found"

# 6. Permission Check: Member tries to remove Owner (Should Fail)
echo -e "\n6️⃣  Testing Permission: Member removing Owner (Should Fail)..."
# Note: We need to simulate the request coming from the New User. 
# However, our current mock setup in `team.js` uses `X-User-Id` to determine the requestor.
# We also need to make sure the New User has this bot as their current bot (or we pass botId implicitly via context, but our API relies on `current_token` or `userBots.currentBotId`).
# Since `handleAcceptInvite` updates the new user's bot list and sets it as default if empty, this should work.

REMOVE_RES=$(curl -s -X DELETE -H "Content-Type: application/json" -H "X-User-Id: $NEW_USER_ID" -d "{\"targetUserId\":\"$OWNER_ID\"}" "$API_URL/team/members")
echo $REMOVE_RES
echo $REMOVE_RES | grep "error" && echo "✅ Permission Denied (Expected)" || echo "❌ Permission Check Failed"

echo -e "\n🎉 Test Complete!"
