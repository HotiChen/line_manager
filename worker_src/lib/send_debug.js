/**
 * send_debug — 暫時診斷用：記錄「真正送給 LINE 的請求」
 *
 * 目的：比對 LM 送出的 JSON 與人手動用 LINE push API 送的有什麼不同
 * （症狀：Bridge 交件通知在 iPhone 收得到、電腦版 LINE 收不到）。
 *
 * 預設完全關閉 —— 只有 env.BRIDGE_DEBUG_SEND === "1"（精確字串）才會記錄，
 * 與 BRIDGE_ENABLED 同一套慣例。查完請把旗標刪掉，並一併移除這個檔案
 * 與它的呼叫點（line_api.js 的 postMessages、bridge/notify.js 的 execute）。
 *
 * 記錄的紅線（tests/unit/test_send_debug.mjs 把關）：
 *   - 不記 access token：Authorization 只留長度與 SHA-256 前 8 碼指紋
 *     （指紋不可逆，用途只有「LM 用的 channel token 與我手動測的是不是同一把」）
 *   - 不記 LINE userId：body 文字裡的 to 換成 `<uid:xxxxxx>`（SHA-256 前 6 碼）
 *   - 其餘內容逐字保留（messages、header 名稱與大小寫、byte 長度）—— 要比對的就是它
 *   - 記錄是盡力而為：任何錯誤都吞掉，不可讓發送失敗
 *
 * 注意：開啟後 log 會含標題、內文與網址（那是這次要比對的東西），
 * 所以它跟 bridge 平時「console 不含使用者內容」的約定是刻意的例外，靠旗標隔離。
 */
import { sha256Hex } from "./crypto_util.js";

const TAG = "[SendDebug]";
const encoder = new TextEncoder();

/** 旗標：精確字串 "1" 才開（缺值、""、"0"、"true"、數字 1 都是關） */
export function sendDebugEnabled(env) {
    return Boolean(env) && env.BRIDGE_DEBUG_SEND === "1";
}

/** LINE userId → `<uid:` + SHA-256 前 6 碼。同一個 id 永遠相同，可用來跨兩邊比對是不是同一個人 */
export async function maskUserId(id) {
    return `<uid:${(await sha256Hex(String(id))).slice(0, 6)}>`;
}

/** Bearer <token> → `Bearer <redacted len=N fp=xxxxxxxx>`；token 原文不出現 */
async function maskAuthorization(value) {
    const raw = String(value);
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    return `Bearer <redacted len=${token.length} fp=${(await sha256Hex(token)).slice(0, 8)}>`;
}

async function maskHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        out[k] = k.toLowerCase() === "authorization" ? await maskAuthorization(v) : v;
    }
    return out;
}

/** 記錄不可讓發送失敗 */
async function quietly(fn) {
    try {
        await fn();
    } catch (err) {
        console.error(`${TAG} logging failed:`, err && err.message);
    }
}

export function debugLog(what, data) {
    return quietly(async () => console.log(`${TAG} ${what}`, JSON.stringify(data)));
}

/**
 * 送出前：url、method、header、body（逐字，只有 userId 被遮）與真正的 byte 長度。
 *
 * @param {string} label "Push" / "Multicast"
 * @param {string} url
 * @param {Object} headers 真正交給 fetch 的 header 物件
 * @param {{to: string|string[]}} payload 真正送出的 payload（取 to 來決定要遮哪些字串）
 * @param {string} bodyText 真正送出的 body 字串
 */
export function logSendRequest(label, url, headers, payload, bodyText) {
    return quietly(async () => {
        const recipients = Array.isArray(payload && payload.to) ? payload.to : [payload && payload.to];
        let body = String(bodyText);
        for (const id of recipients) {
            if (typeof id === "string" && id !== "") body = body.split(id).join(await maskUserId(id));
        }
        console.log(`${TAG} ${label} request`, JSON.stringify({
            url,
            method: "POST",
            headers: await maskHeaders(headers),
            body_bytes: encoder.encode(String(bodyText)).length,
            body,
        }));
    });
}

/** 送出後：狀態碼與 LINE 的 x-line-request-id（可以拿去跟手動送的那次對照） */
export function logSendResponse(label, response) {
    return quietly(async () => console.log(`${TAG} ${label} response`, JSON.stringify({
        status: response.status,
        request_id: response.headers.get("x-line-request-id"),
    })));
}
