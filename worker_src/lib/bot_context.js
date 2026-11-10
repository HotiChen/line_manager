/**
 * bot_context — userId ↔ botId 的橋接
 *
 * 16 個 handler 現在收到的是「呼叫者本人的 userId」，要改成以 bot 為命名空間，
 * 得先能回答兩個問題：
 *
 *   這個登入的人現在正在操作哪一個 bot？   resolveBotId(env, userId)
 *   這個 bot 是誰的？                      resolveOwner(env, botId)
 *
 * 兩個答案本來就在 KV 裡，只是沒人把它們接起來：
 *
 *   current_token_${userId}   → project 名稱（使用者在後台選的那個）
 *   access_tokens_${userId}   → { [project]: { token, destination, displayName } }
 *   destination_user_${dest}  → userId      （token.js 註冊 token 時建的反查索引）
 *
 * botId 就是 LINE 的 destination。token.js 註冊 access token 時會打
 * /v2/bot/info 取得它，webhook.js 也已經用它分辨事件是哪個官方帳號收到的。
 *
 * 新路徑（user:${userId}:bots 的 currentBotId、bot:${botId}:owner）優先，
 * 讀不到才回退舊路徑 —— 這是雙讀的下半部，讓新舊資料能並存。
 *
 * 所有函式對壞輸入都回 null 或空陣列，不丟例外：它們會在每個請求的
 * 認證之後、分派之前被呼叫，在那裡丟例外等於整個請求 500。
 */
import { BotKeys, UserKeys, V1Keys } from './kv_schema.js';

/** key 組件的最低要求：非空字串且不含 kv_schema 的分隔符 */
function usable(value) {
    return typeof value === 'string' && value !== '' && !value.includes(':');
}

async function readJson(env, key) {
    try {
        return await env.KV_LINE_STORAGE.get(key, { type: 'json' });
    } catch {
        return null;
    }
}

async function readText(env, key) {
    try {
        return await env.KV_LINE_STORAGE.get(key);
    } catch {
        return null;
    }
}

/**
 * 這個使用者目前選定的 botId。
 *
 * @param {Object} env
 * @param {string} userId
 * @returns {Promise<string|null>} 沒有選定或解析不出來時回 null —— 不可亂猜一個，
 *   猜錯等於把資料寫到別的 bot 的命名空間。
 */
export async function resolveBotId(env, userId) {
    if (!usable(userId) || !env || !env.KV_LINE_STORAGE) return null;

    // 新路徑
    const userBots = await readJson(env, UserKeys.bots(userId));
    if (userBots && usable(userBots.currentBotId)) return userBots.currentBotId;

    // 舊路徑：current_token 指向的 project，再從 access_tokens 取 destination
    const project = await readText(env, V1Keys.currentToken(userId));
    if (!usable(project)) return null;

    const accessTokens = await readJson(env, V1Keys.accessTokens(userId));
    if (!accessTokens || typeof accessTokens !== 'object') return null;

    const info = accessTokens[project];
    // 舊格式會把 token 直接存成字串，沒有 destination 可用
    if (!info || typeof info !== 'object') return null;

    return usable(info.destination) ? info.destination : null;
}

/**
 * 這個 bot 的擁有者 userId。
 *
 * migration 與雙讀都需要它 —— 舊資料的 key 綁的是 owner，不是 bot。
 *
 * @param {Object} env
 * @param {string} botId
 * @returns {Promise<string|null>}
 */
export async function resolveOwner(env, botId) {
    if (!usable(botId) || !env || !env.KV_LINE_STORAGE) return null;

    const fresh = await readText(env, BotKeys.owner(botId));
    if (usable(fresh)) return fresh;

    const legacy = await readText(env, V1Keys.destinationUser(botId));
    return usable(legacy) ? legacy : null;
}

/**
 * 這個使用者有哪些 bot。
 *
 * 供後台的 bot 切換選單使用，也供 migration 列出一個 owner 要搬幾個 bot。
 *
 * @param {Object} env
 * @param {string} userId
 * @returns {Promise<Array<{botId: string, project: string, displayName: string, isCurrent: boolean}>>}
 */
export async function listBotsOfUser(env, userId) {
    if (!usable(userId) || !env || !env.KV_LINE_STORAGE) return [];

    const accessTokens = await readJson(env, V1Keys.accessTokens(userId));
    if (!accessTokens || typeof accessTokens !== 'object') return [];

    const current = await readText(env, V1Keys.currentToken(userId));

    const bots = [];
    for (const [project, info] of Object.entries(accessTokens)) {
        // 沒有 destination 就沒有 botId，跳過 —— 否則會產生 botId 為 undefined 的項目
        if (!info || typeof info !== 'object' || !usable(info.destination)) continue;
        bots.push({
            botId: info.destination,
            project,
            displayName: usable(info.displayName) ? info.displayName : project,
            isCurrent: project === current,
        });
    }
    return bots;
}
