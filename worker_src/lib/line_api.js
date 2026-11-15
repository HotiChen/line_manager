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
