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
 * 資料結構（維持不變，只有 token 欄位的內容從明文變密文）：
 *
 *   access_tokens_${userId} = { [project]: { token, destination, displayName } }
 *   current_token_${userId} = project 名稱
 */
import { V1Keys } from './kv_schema.js';
import { decryptToken, encryptToken } from './token_crypto.js';

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
