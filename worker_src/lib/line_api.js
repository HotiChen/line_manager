import { getCurrentAccessToken } from "./token_store.js";

/**
 * 當前專案的 access token。
 *
 * 實作在 lib/token_store.js —— 讀寫一律走那裡，因為 token 現在是加密存放，
 * 解密邏輯不可散落（見該檔案開頭的說明）。
 */
export async function getAccessToken(env, userId) {
    return getCurrentAccessToken(env, userId);
}

/**
 * LINE API 回了非 2xx。
 *
 * 橋接 API 需要分辨「對象封鎖了我們（403）」「頻率或額度（429）」「稍後重試」，
 * 所以帶 status，而不是只丟一段字串。message 的文字與舊版相同，既有呼叫端不受影響。
 */
export class LineApiError extends Error {
    constructor(message, { status, body = null, retryAfter = null, acceptedRequestId = null } = {}) {
        super(message);
        this.name = "LineApiError";
        this.status = status;
        /** LINE 回的 JSON；不是 JSON（例如 502 的 HTML）時為 null */
        this.body = body;
        /** Retry-After header（秒），沒有就是 null */
        this.retryAfter = retryAfter;
        /** 409 時 LINE 告知「這個 retry key 先前已被接受」的 request id */
        this.acceptedRequestId = acceptedRequestId;
    }
}

async function readJsonLoose(response) {
    const text = await response.text();
    if (text === "") return {};
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function lineHeaders(token, retryKey) {
    const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
    };
    // LINE 的 X-Line-Retry-Key：同一把 key 重送，LINE 不會重複投遞
    if (retryKey) headers["X-Line-Retry-Key"] = retryKey;
    return headers;
}

async function postMessages(label, url, token, payload, retryKey) {
    const response = await fetch(url, {
        method: "POST",
        headers: lineHeaders(token, retryKey),
        body: JSON.stringify(payload),
    });

    const resJson = await readJsonLoose(response);

    if (!response.ok) {
        console.error(`[LINE API] ${label} failed: ${response.status}`, resJson);
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
        throw new LineApiError(`LINE API ${label} failed: ${JSON.stringify(resJson)}`, {
            status: response.status,
            body: resJson,
            retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
            acceptedRequestId: response.headers.get("X-Line-Accepted-Request-Id"),
        });
    }

    return resJson;
}

/**
 * @param {string} token
 * @param {string} to
 * @param {Object[]} messages
 * @param {{retryKey?: string}} [options] retryKey 必須是 UUID（LINE 的規定）
 */
export async function pushMessage(token, to, messages, options = {}) {
    return postMessages("Push", "https://api.line.me/v2/bot/message/push", token, { to, messages }, options.retryKey);
}

/** 單次最多 500 人（LINE 上限）。 */
export const MULTICAST_MAX_RECIPIENTS = 500;

/**
 * @param {string} token
 * @param {string[]} to
 * @param {Object[]} messages
 * @param {{retryKey?: string}} [options]
 */
export async function multicastMessage(token, to, messages, options = {}) {
    if (!Array.isArray(to) || to.length === 0) {
        throw new Error("multicast requires a non-empty array of recipients");
    }
    if (to.length > MULTICAST_MAX_RECIPIENTS) {
        throw new Error(`multicast supports at most ${MULTICAST_MAX_RECIPIENTS} recipients`);
    }
    return postMessages("Multicast", "https://api.line.me/v2/bot/message/multicast", token, { to, messages }, options.retryKey);
}

export async function broadcastMessage(token, messages) {
    const url = "https://api.line.me/v2/bot/message/broadcast";
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
            messages
        })
    });

    if (!response.ok) {
        const errBody = await response.text();
        console.error(`[LINE API] Broadcast failed: ${response.status} ${errBody}`);
        throw new Error(`LINE API Broadcast failed: ${errBody}`);
    }

    return await response.json();
}

async function getJson(label, url, token) {
    const response = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    const body = await readJsonLoose(response);
    if (!response.ok) {
        console.error(`[LINE API] ${label} failed: ${response.status}`, body);
        throw new LineApiError(`LINE API ${label} failed: ${JSON.stringify(body)}`, {
            status: response.status,
            body,
        });
    }
    return body;
}

/** 本月訊息上限。{ type: "limited", value: 200 } 或 { type: "none" }（無上限）。查詢本身不計費。 */
export function getMessageQuota(token) {
    return getJson("Quota", "https://api.line.me/v2/bot/message/quota", token);
}

/** 本月已用量。{ totalUsage: N }。查詢本身不計費。 */
export function getMessageQuotaConsumption(token) {
    return getJson("Quota consumption", "https://api.line.me/v2/bot/message/quota/consumption", token);
}

// ── LINE Login channel（LM-4C：LIFF Server API 與 ID token 驗證）──
//
// 這一段的函式處理 channel secret、channel access token、ID token —— 都是不能進 log 的東西。
// 所以失敗時只記 HTTP 狀態碼，不記請求本文，也不記 LINE 回的 JSON（本文可能回顯輸入）。
// 端點與參數依 LINE 官方文件：
//   - LIFF Server API  https://developers.line.biz/en/reference/liff-server/
//   - 驗證 ID token    https://developers.line.biz/en/docs/line-login/verify-id-token/
//   - 發 channel access token（stateless v3／short-lived）：整理自 Messaging API reference，
//     用 channel ID＋secret 的 client_credentials；LINE Login channel 是否接受要在真環境實測。

const LINE_API_BASE = "https://api.line.me";

async function loginFetch(label, url, init) {
    let response;
    try {
        response = await fetch(url, init);
    } catch (err) {
        console.error(`[LINE API] ${label} network error:`, err && err.name);
        throw new LineApiError(`LINE API ${label} unreachable`, { status: 0 });
    }
    const body = await readJsonLoose(response);
    if (!response.ok) {
        console.error(`[LINE API] ${label} failed: ${response.status}`);
        throw new LineApiError(`LINE API ${label} failed (${response.status})`, { status: response.status, body });
    }
    return body;
}

const formBody = (fields) => new URLSearchParams(fields).toString();

/**
 * 用 channel ID 與 secret 換 LINE Login channel 的 access token。
 * 先試 stateless（POST /oauth2/v3/token，15 分鐘、不必保存）；被拒絕（4xx）時退回 short-lived
 * （POST /v2/oauth/accessToken，30 天——只在這次呼叫內使用，不保存）。網路／5xx 不退回，直接丟錯。
 *
 * @param {string} channelId
 * @param {string} channelSecret
 * @returns {Promise<string>} access token（呼叫端不得記錄）
 * @throws {LineApiError}
 */
export async function issueLoginChannelToken(channelId, channelSecret) {
    const params = { grant_type: "client_credentials", client_id: channelId, client_secret: channelSecret };
    const init = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: formBody(params) };
    let result;
    try {
        result = await loginFetch("Issue stateless token", `${LINE_API_BASE}/oauth2/v3/token`, init);
    } catch (err) {
        if (!(err instanceof LineApiError) || err.status < 400 || err.status >= 500) throw err;
        result = await loginFetch("Issue short-lived token", `${LINE_API_BASE}/v2/oauth/accessToken`, init);
    }
    if (!result || typeof result.access_token !== "string" || result.access_token === "") {
        throw new LineApiError("LINE API token response has no access_token", { status: 502 });
    }
    return result.access_token;
}

/** @returns {Promise<{liffId: string, view: {type: string, url: string}}[]>} 沒有任何 LIFF（404）→ [] */
export async function listLiffApps(loginToken) {
    try {
        const body = await loginFetch("List LIFF apps", `${LINE_API_BASE}/liff/v1/apps`, { headers: { Authorization: `Bearer ${loginToken}` } });
        return Array.isArray(body && body.apps) ? body.apps : [];
    } catch (err) {
        if (err instanceof LineApiError && err.status === 404) return [];
        throw err;
    }
}

/**
 * 建立 LIFF App。只開 openid scope（只需要 ID token 與 sub，不取名字與頭像）。
 *
 * @param {string} loginToken
 * @param {{endpointUrl: string, description: string}} app endpointUrl 必須是 https 且沒有 fragment
 * @returns {Promise<string>} liffId
 */
export async function createLiffApp(loginToken, { endpointUrl, description }) {
    const body = await loginFetch("Create LIFF app", `${LINE_API_BASE}/liff/v1/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginToken}` },
        body: JSON.stringify({
            view: { type: "full", url: endpointUrl },
            description,
            scope: ["openid"],
            botPrompt: "none",
            permanentLinkPattern: "concat",
        }),
    });
    if (!body || typeof body.liffId !== "string" || body.liffId === "") {
        throw new LineApiError("LINE API create LIFF app returned no liffId", { status: 502 });
    }
    return body.liffId;
}

/** 刪除 LIFF App。已經不存在（404）也算成功。 */
export async function deleteLiffApp(loginToken, liffId) {
    try {
        await loginFetch("Delete LIFF app", `${LINE_API_BASE}/liff/v1/apps/${encodeURIComponent(liffId)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${loginToken}` },
        });
    } catch (err) {
        if (!(err instanceof LineApiError && err.status === 404)) throw err;
    }
}

const ID_TOKEN_ISSUER = "https://access.line.me";

/**
 * 向 LINE 驗證 ID token（簽章、過期、對象 channel 都由 LINE 檢查），再在本地確認 iss、aud、sub、exp。
 * 不信任任何由客戶端傳來的 userId —— 身分只來自驗證成功的 `sub`。
 *
 * @param {string} idToken
 * @param {string} channelId 預期的 LINE Login channel ID
 * @param {number} [now] 毫秒
 * @returns {Promise<{ok: true, sub: string} | {ok: false, reason: "invalid" | "unavailable"}>}
 *   invalid = 這個 token 不能用（簽章、過期、對象不符）；unavailable = LINE 暫時不可用（可重試）
 */
export async function verifyIdToken(idToken, channelId, now = Date.now()) {
    if (typeof idToken !== "string" || idToken === "" || idToken.length > 4096) return { ok: false, reason: "invalid" };
    let claims;
    try {
        claims = await loginFetch("Verify ID token", `${LINE_API_BASE}/oauth2/v2.1/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody({ id_token: idToken, client_id: channelId }),
        });
    } catch (err) {
        const transient = !(err instanceof LineApiError) || err.status === 0 || err.status === 429 || err.status >= 500;
        return { ok: false, reason: transient ? "unavailable" : "invalid" };
    }
    if (!claims || typeof claims !== "object") return { ok: false, reason: "invalid" };
    const exp = Number(claims.exp);
    if (claims.iss !== ID_TOKEN_ISSUER || String(claims.aud) !== String(channelId)
        || typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > 128
        || !Number.isFinite(exp) || exp * 1000 <= now) {
        return { ok: false, reason: "invalid" };
    }
    return { ok: true, sub: claims.sub };
}
