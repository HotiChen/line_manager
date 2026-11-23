/**
 * token_store — LINE channel access token 的單一存取出口
 *
 * 原本有 9 個地方各自讀 `access_tokens_${userId}` 再從裡面挖 token，而且
 * 「值是物件還是字串」的判斷寫了至少三種版本：
 *
 *   (typeof info === "object" && info !== null) ? info.token : info
 *   typeof currentData === 'string' ? currentData : currentData?.token
 *   tokenMap[currentProject]?.token || tokenMap[currentProject]
 *
 * 要加入靜態加密，把解密散到那 9 個地方等於保證漏掉一個 —— 而漏掉一個是
 * 最難發現的那種壞法：一段密文被當成 token 送去 LINE，報錯在別人家。
 *
 * 所以讀寫一律走這裡。四個函式對應那 9 處的四種取用模式：
 *
 *   getCurrentAccessToken        當前選定專案的 token（4 處用這個）
 *   getAccessTokenForProject     指定專案名稱（3 處）
 *   getAccessTokenForDestination webhook 用 destination 反查（1 處）
 *   saveAccessToken              寫入，一律加密
 *
 * 後來又加了兩個，因為「當前選定專案」本身就是 bug 的來源（見下方
 * getAccessTokenForStore 的註解）：
 *
 *   getAccessTokenForStore       以一個 BotStore 已確定的 botId 為準
 *   getAccessTokenForCurrentBot  沒有 store 時自己解析一次 botId
 *
 * 新程式一律用這兩個；getCurrentAccessToken 留著給它們當退路。
 *
 * 資料結構（維持不變，只有 token 欄位的內容從明文變密文）：
 *
 *   access_tokens_${userId} = { [project]: { token, destination, displayName } }
 *   current_token_${userId} = project 名稱
 */
import { V1Keys } from './kv_schema.js';
import { decryptToken, encryptToken } from './token_crypto.js';
import { resolveBotId } from './bot_context.js';

/**
 * 從一筆 project 資料裡取出 token 欄位。
 *
 * 舊格式把值直接存成字串 token，新格式是物件 —— 兩種都還在正式環境裡。
 *
 * @param {unknown} info
 * @returns {string|null}
 */
function rawToken(info) {
    if (typeof info === 'string') return info === '' ? null : info;
    if (info && typeof info === 'object' && typeof info.token === 'string' && info.token !== '') {
        return info.token;
    }
    return null;
}

async function readMap(env, userId) {
    const map = await env.KV_LINE_STORAGE.get(V1Keys.accessTokens(userId), { type: 'json' });
    return map && typeof map === 'object' ? map : {};
}

/**
 * 當前選定專案的 access token（已解密）。
 *
 * @param {Object} env
 * @param {string} userId
 * @returns {Promise<string|null>} 沒有選定專案、專案不存在、或沒有 token 時回 null
 */
export async function getCurrentAccessToken(env, userId) {
    const project = await env.KV_LINE_STORAGE.get(V1Keys.currentToken(userId));
    if (!project) return null;
    return getAccessTokenForProject(env, userId, project);
}

/**
 * 指定專案名稱的 access token（已解密）。
 *
 * @param {Object} env
 * @param {string} userId
 * @param {string} project
 * @returns {Promise<string|null>}
 */
export async function getAccessTokenForProject(env, userId, project) {
    if (!project) return null;
    const map = await readMap(env, userId);
    const stored = rawToken(map[project]);
    if (stored === null) return null;
    return decryptToken(env, stored);
}

/**
 * 用 LINE 的 destination 反查 access token —— webhook 進來時只有 destination。
 *
 * @param {Object} env
 * @param {string} userId
 * @param {string} destination
 * @returns {Promise<{token: string|null, projectName: string|null}>}
 */
export async function getAccessTokenForDestination(env, userId, destination) {
    if (!destination) return { token: null, projectName: null };

    const map = await readMap(env, userId);
    for (const [projectName, info] of Object.entries(map)) {
        if (!info || typeof info !== 'object' || info.destination !== destination) continue;
        const stored = rawToken(info);
        if (stored === null) continue;
        return { token: await decryptToken(env, stored), projectName };
    }
    return { token: null, projectName: null };
}

/**
 * 一個 bot（destination）的 token，查不到就是 null。
 */
async function tokenForBot(env, userId, botId) {
    const { token } = await getAccessTokenForDestination(env, userId, botId);
    return token;
}

/** key 組件的最低要求，跟 bot_context / bot_store 一致 */
function usableId(value) {
    return typeof value === 'string' && value !== '';
}

/**
 * 一個 BotStore 所屬 bot 的 access token（已解密）。
 *
 * ## 為什麼不能用 getCurrentAccessToken
 *
 * 資料與 token 的「是哪個官方帳號」來自兩條不同的路：
 *
 *   資料（bot_store）  botId —— webhook 是事件的 destination，後台是使用者選的 bot
 *   token             current_token_${userId} —— 使用者在後台選的「專案名稱」
 *
 * 正常情況兩者一致，所以平常看不出來。錯開的時候也不會報錯，只是把
 * 請求送到別的官方帳號去：
 *
 *   - 推播：名單是 A 帳號的會員，token 是 B 帳號的 → LINE 回 400
 *     Invalid user id，而後台畫面上一切正常。
 *   - webhook：A 帳號有人加好友，store 的 botId 正確是 A，但 token 讀的是
 *     owner 此刻在後台選的 B → 圖文選單掛到錯的帳號上去。
 *
 * 所以 token 跟著資料走，以 store 的 botId 為準。
 *
 * ## 兩種回 null 的情況，意思不一樣
 *
 *   botId 算不出來  → 退回 current_token。那是舊資料的常態（access_tokens
 *                     的值是字串、沒有 destination），不是錯開，退回去才不退步。
 *   botId 有、但那個 bot 沒登記 token → null，不退回 current_token。
 *     這時退回去等於把上面那個 bug 原封不動放回來：呼叫端寧可收到
 *     「沒有 token」這個誠實的錯誤，也不要安靜地操作到別人的帳號。
 *     補救方式是在後台把那個帳號的 access token 重新存一次。
 *
 * @param {{env: Object, userId: string|null, botId: string|null}} store
 * @returns {Promise<string|null>}
 */
export async function getAccessTokenForStore(store) {
    if (!store || !store.env || !usableId(store.userId)) return null;
    const { env, userId, botId } = store;
    if (!usableId(botId)) return getCurrentAccessToken(env, userId);
    return tokenForBot(env, userId, botId);
}

/**
 * 這個使用者「當下選定的 bot」的 access token（已解密）。
 *
 * 給手上沒有 BotStore 的呼叫端用 —— 它自己解析一次 botId，語意與
 * getAccessTokenForStore 相同（包含 fail-closed 的部分）。
 *
 * 已經有 store 的地方請用 getAccessTokenForStore：webhook 路徑的 botId 是
 * 事件的 destination，重新解析一次會得到「owner 現在選的 bot」，也就是
 * 這兩個函式要避免的那個錯。
 *
 * @param {Object} env
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function getAccessTokenForCurrentBot(env, userId) {
    if (!env || !env.KV_LINE_STORAGE || !usableId(userId)) return null;
    const botId = await resolveBotId(env, userId);
    if (!botId) return getCurrentAccessToken(env, userId);
    return tokenForBot(env, userId, botId);
}

/**
 * 寫入一個專案的 access token，一律加密。
 *
 * destination 與 displayName 不加密 —— 它們不是祕密，而且要能用來查詢
 * （webhook 的反查、後台的清單）。加密它們只會讓每次查詢都得先解密全部。
 *
 * 缺金鑰時丟錯而不是降級存明文：允許降級，「已加密」就變成一個沒有根據的
 * 假設，而呼叫端無從得知自己存進去的是什麼。
 *
 * @param {Object} env
 * @param {string} userId
 * @param {string} project
 * @param {{token: string, destination?: string, displayName?: string}} info
 * @returns {Promise<void>}
 * @throws 缺少 TOKEN_ENCRYPTION_KEY，或 token 不是非空字串
 */
export async function saveAccessToken(env, userId, project, info) {
    // 先加密再讀現有資料：加密失敗時不留下任何痕跡
    const sealed = await encryptToken(env, info.token);

    const key = V1Keys.accessTokens(userId);
    const map = await readMap(env, userId);
    map[project] = {
        token: sealed,
        destination: info.destination,
        displayName: info.displayName,
    };
    await env.KV_LINE_STORAGE.put(key, JSON.stringify(map));
}
