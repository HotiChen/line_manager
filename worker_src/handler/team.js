import { jsonResponse } from "../lib/utils.js";
import { BotKeys, UserKeys, InviteKeys } from "../lib/kv_schema.js";
import { withPermission } from "../middleware/permission.js";

/**
 * 取得團隊成員列表
 */
export async function handleListMembers(request, env, userId, botId, role) {
    const permissionsKey = BotKeys.permissions(botId);
    const permissions = await env.KV_LINE_STORAGE.get(permissionsKey, { type: "json" });

    if (!permissions) {
        return jsonResponse({ error: "Bot permissions not found" }, 404);
    }

    return jsonResponse({
        success: true,
        members: permissions.users,
        currentUserRole: role
    });
}

/**
 * 新增成員 (直接新增，僅供測試或特殊用途，一般建議用邀請連結)
 */
export async function handleAddMember(request, env, userId, botId, role) {
    const { newUserId, newRole = "member", displayName } = await request.json();

    if (!newUserId) {
        return jsonResponse({ error: "Missing newUserId" }, 400);
    }

    const permissionsKey = BotKeys.permissions(botId);
    const permissions = await env.KV_LINE_STORAGE.get(permissionsKey, { type: "json" }) || { users: [] };

    // 檢查是否已存在
    if (permissions.users.find(u => u.userId === newUserId)) {
        return jsonResponse({ error: "User already exists in the team" }, 400);
    }

    const newMember = {
        userId: newUserId,
        role: newRole,
        displayName: displayName || "New Member",
        addedAt: new Date().toISOString(),
        addedBy: userId
    };

    permissions.users.push(newMember);
    await env.KV_LINE_STORAGE.put(permissionsKey, JSON.stringify(permissions));

    // 更新使用者的 Bot 列表 (反向索引)
    await updateUserBotList(env, newUserId, botId, newRole);

    return jsonResponse({ success: true, member: newMember });
}

/**
 * 移除成員
 */
export async function handleRemoveMember(request, env, userId, botId, role) {
    const { targetUserId } = await request.json();

    if (!targetUserId) {
        return jsonResponse({ error: "Missing targetUserId" }, 400);
    }

    if (targetUserId === userId) {
        return jsonResponse({ error: "Cannot remove yourself" }, 400);
    }

    const permissionsKey = BotKeys.permissions(botId);
    const permissions = await env.KV_LINE_STORAGE.get(permissionsKey, { type: "json" });

    if (!permissions) {
        return jsonResponse({ error: "Bot permissions not found" }, 404);
    }

    const initialLength = permissions.users.length;
    permissions.users = permissions.users.filter(u => u.userId !== targetUserId);

    if (permissions.users.length === initialLength) {
        return jsonResponse({ error: "User not found in team" }, 404);
    }

    await env.KV_LINE_STORAGE.put(permissionsKey, JSON.stringify(permissions));

    // 移除使用者的 Bot 列表中的該 Bot
    await removeUserBotList(env, targetUserId, botId);

    return jsonResponse({ success: true, message: "Member removed" });
}

/**
 * 產生邀請連結
 */
export async function handleGenerateInvite(request, env, userId, botId, role) {
    const { inviteRole = "member", expiresInHours = 24, targetBotIds = [] } = await request.json();

    // 如果沒有指定 targetBotIds，則預設使用當前 botId (單一專案模式)
    const botIds = targetBotIds.length > 0 ? targetBotIds : [botId];

    // ✅ 嚴格驗證使用者是否擁有所有 Bot 的 Owner 權限
    for (const targetBotId of botIds) {
        const permissionsKey = BotKeys.permissions(targetBotId);
        const permissions = await env.KV_LINE_STORAGE.get(permissionsKey, { type: "json" });

        if (!permissions) {
            console.error(`[Security] Bot permissions not found for ${targetBotId}`);
            return jsonResponse({ error: `Bot not found: ${targetBotId}` }, 404);
        }

        // 檢查當前用戶是否為此 Bot 的 Owner
        const userPermission = permissions.users.find(u => u.userId === userId);
        if (!userPermission || userPermission.role !== 'owner') {
            console.error(`[Security] User ${userId} attempted to generate invite for bot ${targetBotId} without owner permission`);
            return jsonResponse({ error: `Insufficient permissions for bot: ${targetBotId}` }, 403);
        }
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + expiresInHours);

    const inviteData = {
        token,
        botIds, // 儲存 Bot ID 陣列
        role: inviteRole,
        createdBy: userId,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        used: false
    };

    const inviteKey = InviteKeys.token(token);
    // 設定 KV 過期時間 (秒)
    await env.KV_LINE_STORAGE.put(inviteKey, JSON.stringify(inviteData), {
        expirationTtl: expiresInHours * 3600
    });

    // 根據環境變數決定邀請連結的 domain
    const baseUrl = env.BASE_URL || `https://liff.line.me/${env.LIFF_ID}`;
    const inviteUrl = `${baseUrl}/pages/invite.html?token=${token}`;

    return jsonResponse({
        success: true,
        inviteUrl,
        token,
        expiresAt
    });
}

/**
 * 預覽邀請資訊（不接受邀請）
 * 用於顯示確認畫面
 */
export async function handlePreviewInvite(request, env) {
    const { token } = await request.json();

    if (!token) {
        return jsonResponse({ error: "Missing token" }, 400);
    }

    const inviteKey = InviteKeys.token(token);
    const inviteData = await env.KV_LINE_STORAGE.get(inviteKey, { type: "json" });

    if (!inviteData) {
        return jsonResponse({ error: "Invalid or expired invite token" }, 404);
    }

    if (inviteData.used) {
        return jsonResponse({ error: "Invite token already used" }, 400);
    }

    // 獲取所有 Bot 的詳細資訊 (名稱)
    const botIds = inviteData.botIds || [inviteData.botId]; // 相容舊資料
    const bots = [];

    for (const botId of botIds) {
        const botInfoKey = BotKeys.info(botId);
        const botInfo = await env.KV_LINE_STORAGE.get(botInfoKey, { type: "json" });
        bots.push({
            botId,
            name: botInfo?.name || `Bot (${botId.substring(0, 8)}...)`
        });
    }

    // 返回邀請資訊（不包含敏感資料）
    return jsonResponse({
        success: true,
        botId: inviteData.botId, // 保留相容性
        botIds,
        bots, // 新增：包含名稱的 Bot 列表
        role: inviteData.role,
        createdBy: inviteData.createdBy,
        createdAt: inviteData.createdAt,
        expiresAt: inviteData.expiresAt
    });
}

/**
 * 接受邀請 (不需要 withPermission，因為是新成員)
 * userId 由 router 從認證 context 傳入，body 的 userId 欄位被忽略（SEC-001）
 */
export async function handleAcceptInvite(request, env, userId) {
    const { token, displayName, pictureUrl } = await request.json();

    if (!token || !userId) {
        return jsonResponse({ error: "Missing token or userId" }, 400);
    }

    const inviteKey = InviteKeys.token(token);
    const inviteData = await env.KV_LINE_STORAGE.get(inviteKey, { type: "json" });

    if (!inviteData) {
        return jsonResponse({ error: "Invalid or expired invite token" }, 404);
    }

    if (inviteData.used) {
        return jsonResponse({ error: "Invite token already used" }, 400);
    }

    // 支援多 Bot 邀請
    const botIds = inviteData.botIds || [inviteData.botId]; // 相容舊資料

    // ✅ 追蹤成功和失敗的 Bot
    const successfulBots = [];
    const failedBots = [];

    for (const botId of botIds) {
        try {

            // 加入團隊
            const permissionsKey = BotKeys.permissions(botId);
            const permissions = await env.KV_LINE_STORAGE.get(permissionsKey, { type: "json" }) || { users: [] };

            // 檢查是否已經是成員
            const existingMember = permissions.users.find(u => u.userId === userId);
            if (existingMember) {
                successfulBots.push({ botId, status: 'already_member' });
                continue;
            }

            // 添加新成員
            permissions.users.push({
                userId,
                role: inviteData.role,
                displayName: displayName || "Member",
                pictureUrl,
                addedAt: new Date().toISOString(),
                addedBy: inviteData.createdBy
            });

            await env.KV_LINE_STORAGE.put(permissionsKey, JSON.stringify(permissions));

            // 更新使用者的 Bot 列表
            await updateUserBotList(env, userId, botId, inviteData.role);

            successfulBots.push({ botId, status: 'joined' });

        } catch (error) {
            console.error(`[AcceptInvite] ❌ Failed to add user to bot ${botId}:`, error);
            failedBots.push({ botId, error: error.message });
        }
    }

    // ✅ 只有在至少有一個 Bot 成功加入時才標記 token 為已使用
    if (successfulBots.length > 0) {
        inviteData.used = true;
        inviteData.usedBy = userId;
        inviteData.usedAt = new Date().toISOString();
        inviteData.joinResults = {
            successful: successfulBots,
            failed: failedBots
        };
        await env.KV_LINE_STORAGE.put(inviteKey, JSON.stringify(inviteData));
    }

    // 返回詳細結果
    if (failedBots.length > 0 && successfulBots.length === 0) {
        // 全部失敗
        return jsonResponse({
            success: false,
            error: "Failed to join any bots",
            details: failedBots
        }, 500);
    } else if (failedBots.length > 0) {
        // 部分成功
        return jsonResponse({
            success: true,
            message: "Partially joined team",
            joinedBots: successfulBots.map(b => b.botId),
            failed: failedBots,
            warning: `Successfully joined ${successfulBots.length} bot(s), but ${failedBots.length} failed`
        });
    } else {
        // 全部成功
        return jsonResponse({
            success: true,
            message: "Joined team successfully",
            joinedBots: successfulBots.map(b => b.botId)
        });
    }
}

/**
 * 列出所有邀請連結 (Debug/Admin 用)
 */
export async function handleListInvites(request, env, userId) {
    // 1. 列出所有 invite: 開頭的 key
    const list = await env.KV_LINE_STORAGE.list({ prefix: "invite:" });
    const invites = [];

    // 2. 批量獲取詳細內容 (或是逐個獲取，量少時沒差)
    for (const key of list.keys) {
        const inviteData = await env.KV_LINE_STORAGE.get(key.name, { type: "json" });
        if (inviteData) {
            // 補上 token 本身 (key name 是 invite:TOKEN)
            // inviteData.token 應該已經有了，但以防萬一
            invites.push(inviteData);
        }
    }

    // 3. 排序 (最新的在前)
    invites.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return jsonResponse({ success: true, invites });
}


// --- Helpers ---

async function updateUserBotList(env, userId, botId, role) {
    const userBotsKey = UserKeys.bots(userId);

    const userBots = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" }) || { bots: [] };

    // 檢查是否已在列表中
    const existingBotIndex = userBots.bots.findIndex(b => b.botId === botId);

    const botInfo = {
        botId,
        role,
        joinedAt: new Date().toISOString()
    };

    if (existingBotIndex >= 0) {
        userBots.bots[existingBotIndex] = { ...userBots.bots[existingBotIndex], ...botInfo };
    } else {
        userBots.bots.push(botInfo);
    }

    // 如果是第一個 Bot，設為預設
    if (!userBots.currentBotId) {
        userBots.currentBotId = botId;
    }

    await env.KV_LINE_STORAGE.put(userBotsKey, JSON.stringify(userBots));
}

async function removeUserBotList(env, userId, botId) {
    const userBotsKey = UserKeys.bots(userId);
    const userBots = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" });

    if (!userBots) return;

    userBots.bots = userBots.bots.filter(b => b.botId !== botId);

    if (userBots.currentBotId === botId) {
        userBots.currentBotId = userBots.bots.length > 0 ? userBots.bots[0].botId : null;
    }

    await env.KV_LINE_STORAGE.put(userBotsKey, JSON.stringify(userBots));
}

// --- Route Handler ---

export function route(request, env, userId, pathname) {
    // 團隊管理 (需要 Owner 權限)
    if (pathname === "/team/members" && request.method === "GET") {
        return withPermission(handleListMembers)(request, env, userId);
    }
    if (pathname === "/team/members" && request.method === "POST") {
        return withPermission(handleAddMember, "owner")(request, env, userId);
    }
    if (pathname === "/team/members" && request.method === "DELETE") {
        return withPermission(handleRemoveMember, "owner")(request, env, userId);
    }

    // 邀請系統 (產生邀請需要 Owner 權限)
    if (pathname === "/team/invite/generate" && request.method === "POST") {
        return withPermission(handleGenerateInvite, "owner")(request, env, userId);
    }
    if (pathname === "/team/invites" && request.method === "GET") {
        return withPermission(handleListInvites, "owner")(request, env, userId);
    }

    // 預覽邀請 (公開 API，用於確認畫面)
    if (pathname === "/team/invite/preview" && request.method === "POST") {
        return handlePreviewInvite(request, env);
    }

    // 接受邀請 (需要認證，userId 由 router 傳入，body 的 userId 被忽略)
    if (pathname === "/team/invite/accept" && request.method === "POST") {
        return handleAcceptInvite(request, env, userId);
    }

    return jsonResponse({ error: "Not found" }, 404);
}
