import { jsonResponse } from "../lib/utils.js";
import { BotKeys, UserKeys } from "../lib/kv_schema.js";

/**
 * 執行單一使用者的資料遷移
 * @param {Object} env 
 * @param {string} userId 
 */
export async function migrateUser(env, userId) {
    const logs = [];
    const log = (msg) => {
        logs.push(msg);
    };

    // 1. 取得使用者的 Access Tokens (專案列表)
    const accessTokensKey = `access_tokens_${userId}`;

    // Debug: List all keys to see what's visible
    const listRef = await env.KV_LINE_STORAGE.list({ prefix: "access_tokens_" });

    const accessTokens = await env.KV_LINE_STORAGE.get(accessTokensKey, { type: "json" });

    if (!accessTokens || Object.keys(accessTokens).length === 0) {
        log(`⚠️ 使用者 ${userId} 沒有任何專案 (access_tokens)，跳過。`);
        return { success: true, logs };
    }

    // 2. 準備使用者的 Bot 列表
    const userBots = {
        bots: [],
        currentBotId: null
    };

    // 3. 讀取使用者現有的共用資料 (Keywords, Flex, Imagemap, Tags, Members)
    // 這些資料目前是 "User Global" 的，遷移時會複製一份到每個 Bot 下

    // Keywords
    const keywordsKey = `keyword_reply_list_${userId}`;
    const userKeywords = await env.KV_LINE_STORAGE.get(keywordsKey, { type: "json" }) || [];

    // Flex Messages (需要 list + get)
    const flexListKey = `flex_list_${userId}`; // 舊的 list key (如果有的話)
    // 或是透過 prefix 搜尋
    const flexListRef = await env.KV_LINE_STORAGE.list({ prefix: `flex_${userId}_` });
    const userFlexMessages = [];
    for (const key of flexListRef.keys) {
        const content = await env.KV_LINE_STORAGE.get(key.name, { type: "json" });
        const name = key.name.replace(`flex_${userId}_`, "");
        if (content) {
            userFlexMessages.push({
                id: `flex_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, // 產生新 ID
                name: name,
                content: content,
                updatedAt: new Date().toISOString()
            });
        }
    }

    // Imagemaps
    const imagemapKey = `imagemap_${userId}`;
    const userImagemaps = await env.KV_LINE_STORAGE.get(imagemapKey, { type: "json" }) || [];

    // Tags
    const tagKey = `tag_list_${userId}`; // 假設的 key，需確認
    const userTags = await env.KV_LINE_STORAGE.get(tagKey, { type: "json" }) || [];

    // Members
    const memberKey = `member_list_${userId}`; // 假設的 key，需確認
    const userMembers = await env.KV_LINE_STORAGE.get(memberKey, { type: "json" }) || [];


    // 4. 遍歷每個專案 (Bot) 進行遷移
    for (const [projectName, info] of Object.entries(accessTokens)) {
        const botId = info.destination; // LINE Bot User ID

        if (!botId) {
            log(`⚠️ 專案 ${projectName} 缺少 destination (Bot ID)，跳過。`);
            continue;
        }

        log(`🔄 正在遷移 Bot: ${projectName} (${botId})...`);

        // 4.1 建立 Bot Info
        const botInfoKey = BotKeys.info(botId);
        const botInfo = {
            botId,
            displayName: info.displayName || projectName,
            channelId: info.channelId || "", // 如果有的話
            createdAt: new Date().toISOString(),
            createdBy: userId,
            originalProjectName: projectName
        };
        await env.KV_LINE_STORAGE.put(botInfoKey, JSON.stringify(botInfo));
        log(`  ✅ Bot Info 已建立`);

        // 4.2 建立 Bot Permissions (Owner)
        const permissionsKey = BotKeys.permissions(botId);
        const permissions = {
            users: [{
                userId,
                role: "owner",
                displayName: "Owner", // 暫時
                addedAt: new Date().toISOString(),
                addedBy: "system_migration"
            }]
        };
        await env.KV_LINE_STORAGE.put(permissionsKey, JSON.stringify(permissions));
        log(`  ✅ Bot Permissions 已建立`);

        // 4.3 遷移 Keywords
        // 為每個 keyword 加上 metadata
        const botKeywords = userKeywords.map(k => ({
            ...k,
            id: k.id || crypto.randomUUID(),
            createdBy: userId,
            updatedBy: userId,
            updatedAt: new Date().toISOString()
        }));
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(botId), JSON.stringify(botKeywords));
        log(`  ✅ Keywords 已遷移 (${botKeywords.length} 筆)`);

        // 4.4 遷移 Flex Messages
        await env.KV_LINE_STORAGE.put(BotKeys.flexList(botId), JSON.stringify(userFlexMessages));
        log(`  ✅ Flex Messages 已遷移 (${userFlexMessages.length} 筆)`);

        // 4.5 遷移 Imagemaps
        await env.KV_LINE_STORAGE.put(BotKeys.imagemaps(botId), JSON.stringify(userImagemaps));
        log(`  ✅ Imagemaps 已遷移 (${userImagemaps.length} 筆)`);

        // 4.6 遷移 Tags
        await env.KV_LINE_STORAGE.put(BotKeys.tags(botId), JSON.stringify(userTags));
        log(`  ✅ Tags 已遷移 (${userTags.length} 筆)`);

        // 4.7 遷移 Members
        await env.KV_LINE_STORAGE.put(BotKeys.members(botId), JSON.stringify(userMembers));
        log(`  ✅ Members 已遷移 (${userMembers.length} 筆)`);

        // 4.8 加入使用者的 Bot 列表
        userBots.bots.push({
            botId,
            role: "owner",
            displayName: info.displayName || projectName,
            joinedAt: new Date().toISOString()
        });
    }

    // 5. 設定使用者的 Bot 列表
    // 設定預設 Bot (優先使用 current_token)
    const currentTokenKey = `current_token_${userId}`;
    const currentProject = await env.KV_LINE_STORAGE.get(currentTokenKey);

    if (currentProject && accessTokens[currentProject]?.destination) {
        userBots.currentBotId = accessTokens[currentProject].destination;
    } else if (userBots.bots.length > 0) {
        userBots.currentBotId = userBots.bots[0].botId;
    }

    await env.KV_LINE_STORAGE.put(UserKeys.bots(userId), JSON.stringify(userBots));
    log(`✅ 使用者 Bot 列表已更新 (共 ${userBots.bots.length} 個 Bot)`);

    log(`🎉 使用者 ${userId} 遷移完成！`);
    return { success: true, logs };
}

/**
 * 回滾單一使用者的資料遷移 (刪除新建立的 Bot 資料)
 * @param {Object} env 
 * @param {string} userId 
 */
export async function rollbackUser(env, userId) {
    const logs = [];
    const log = (msg) => {
        logs.push(msg);
    };

    log(`⏪ 開始回滾使用者: ${userId}`);

    // 1. 取得使用者的 Bot 列表
    const userBotsKey = UserKeys.bots(userId);
    const userBots = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" });

    if (!userBots || !userBots.bots) {
        log(`⚠️ 使用者 ${userId} 沒有 Bot 列表，無需回滾。`);
        return { success: true, logs };
    }

    // 2. 刪除每個 Bot 的資料
    for (const bot of userBots.bots) {
        const botId = bot.botId;
        log(`🗑️ 正在刪除 Bot 資料: ${botId}...`);

        await env.KV_LINE_STORAGE.delete(BotKeys.info(botId));
        await env.KV_LINE_STORAGE.delete(BotKeys.permissions(botId));
        await env.KV_LINE_STORAGE.delete(BotKeys.keywords(botId));
        await env.KV_LINE_STORAGE.delete(BotKeys.flexList(botId));
        await env.KV_LINE_STORAGE.delete(BotKeys.imagemaps(botId));
        await env.KV_LINE_STORAGE.delete(BotKeys.tags(botId));
        await env.KV_LINE_STORAGE.delete(BotKeys.members(botId));

        log(`  ✅ Bot ${botId} 資料已刪除`);
    }

    // 3. 刪除使用者的 Bot 列表
    await env.KV_LINE_STORAGE.delete(userBotsKey);
    log(`✅ 使用者 Bot 列表已刪除`);

    log(`🎉 使用者 ${userId} 回滾完成！`);
    return { success: true, logs };
}

/**
 * API Handler
 */
export async function handleMigrate(request, env) {
    // 安全檢查：從環境變數讀取 migration secret
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const migrationSecret = env.MIGRATION_SECRET;
    if (!migrationSecret || !key || key !== migrationSecret) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const userId = url.searchParams.get("userId");
    const mode = url.searchParams.get("mode"); // 'migrate' (default) or 'rollback'

    if (!userId) {
        return jsonResponse({ error: "Missing userId" }, 400);
    }

    try {
        if (mode === "rollback") {
            const result = await rollbackUser(env, userId);
            return jsonResponse(result);
        } else {
            const result = await migrateUser(env, userId);
            return jsonResponse(result);
        }
    } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
    }
}
