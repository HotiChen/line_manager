import { jsonResponse } from "../lib/utils.js";
import { UserKeys } from "../lib/kv_schema.js";

/**
 * 取得使用者的 Bot 列表
 */
export async function handleListUserBots(request, env, userId) {
    const userBotsKey = UserKeys.bots(userId);
    const userBots = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" });

    if (!userBots || !userBots.bots) {
        return jsonResponse({ bots: [], currentBotId: null });
    }

    return jsonResponse(userBots);
}

/**
 * 切換當前使用的 Bot
 */
export async function handleSwitchBot(request, env, userId) {
    const { botId } = await request.json();

    if (!botId) {
        return jsonResponse({ error: "Missing botId" }, 400);
    }

    const userBotsKey = UserKeys.bots(userId);
    const userBots = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" });

    if (!userBots || !userBots.bots) {
        return jsonResponse({ error: "User has no bots" }, 404);
    }

    // 驗證使用者是否擁有該 Bot
    const botExists = userBots.bots.find(b => b.botId === botId);
    if (!botExists) {
        return jsonResponse({ error: "Bot not found in your list" }, 403);
    }

    // 更新 currentBotId
    userBots.currentBotId = botId;
    await env.KV_LINE_STORAGE.put(userBotsKey, JSON.stringify(userBots));

    // 同時更新舊的 current_token 以保持向後相容 (如果有的話)
    // 這邊比較複雜，因為舊系統用 project name，新系統用 botId
    // 暫時先不更新舊系統，假設前端會全面改用新 API

    return jsonResponse({ success: true, currentBotId: botId });
}

export function route(request, env, userId, pathname) {
    if (pathname === "/user/bots" && request.method === "GET") {
        return handleListUserBots(request, env, userId);
    }
    if (pathname === "/user/bot/switch" && request.method === "POST") {
        return handleSwitchBot(request, env, userId);
    }

    return jsonResponse({ error: "Not found" }, 404);
}
