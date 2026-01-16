import { jsonResponse } from "../lib/utils.js";
import { BotKeys, UserKeys } from "../lib/kv_schema.js";

/**
 * 檢查使用者權限的中間件
 * 
 * @param {Request} request 
 * @param {Object} env 
 * @param {string} userId 
 * @returns {Promise<{success: boolean, botId?: string, role?: string, error?: string, response?: Response}>}
 */
export async function checkPermission(request, env, userId) {
    // 1. 嘗試從 Header 取得 Bot ID
    let botId = request.headers.get("X-Bot-Id");

    // 2. 如果沒有 Bot ID，嘗試從使用者的預設 Bot 取得 (相容性/便利性)
    if (!botId) {
        const userBotsKey = UserKeys.bots(userId);
        const userBots = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" });

        if (userBots && userBots.currentBotId) {
            botId = userBots.currentBotId;
        } else {
            // 如果連預設 Bot 都沒有，可能是新使用者或資料未遷移
            // 這裡可以選擇回傳錯誤，或者允許某些特定 API 通過 (例如建立 Bot)
            return { success: false, error: "No Bot ID provided and no default bot found." };
        }
    }

    // 3. 檢查權限
    const permissionsKey = BotKeys.permissions(botId);
    const permissions = await env.KV_LINE_STORAGE.get(permissionsKey, { type: "json" });

    if (!permissions || !permissions.users) {
        return { success: false, error: "Bot not found or no permissions set." };
    }

    const userPerm = permissions.users.find(u => u.userId === userId);

    if (!userPerm) {
        return { success: false, error: "Access denied." };
    }

    return {
        success: true,
        botId,
        role: userPerm.role
    };
}

/**
 * 高階函數：要求特定角色的 Handler 包裝器
 * 
 * @param {Function} handler 原始 Handler (request, env, userId, botId, role)
 * @param {string} requiredRole 需要的角色 ('owner' | 'member')，預設 null 表示只要有權限即可
 */
export function withPermission(handler, requiredRole = null) {
    return async (request, env, userId, ...args) => {
        const check = await checkPermission(request, env, userId);

        if (!check.success) {
            return jsonResponse({ error: check.error }, 403);
        }

        if (requiredRole && check.role !== requiredRole) {
            return jsonResponse({ error: `Permission denied. Required role: ${requiredRole}` }, 403);
        }

        // 將 botId 和 role 注入到 handler
        return handler(request, env, userId, check.botId, check.role, ...args);
    };
}
