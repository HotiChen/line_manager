/**
 * 聯絡人綁定（LM-3A）：綁定碼的產生、辨識與消耗，以及 follow／unfollow 對綁定狀態的影響
 *
 * 設計見 docs/integration/lm-3a-plan.md。這個檔案是 webhook 側（lib/event_handler.js）進入 Bridge 的唯一接縫：
 * event_handler 單向呼叫這裡，這裡只經 lm_service 的窄介面取得 LM 的資料，SQL 都在 db.js。
 *
 * 不變量：
 *   - BRIDGE_ENABLED 不是 "1" → 什麼都不做（零 D1、零 KV）；旗標關閉時 webhook 行為與沒有這個檔案時相同
 *   - 文字不「完全」符合綁定碼格式 → 零 D1 查詢（一般聊天不增加延遲）
 *   - 長得像但查無此碼（錯、過期、已用、別的 OA、連結已撤銷）→ 不回任何訊息（不給猜碼者判斷機），照原流程走
 *   - 碼只以 SHA-256 查詢；碼與 LINE userId 絕不進 log、audit 或回應
 *   - 任何例外只記 err.message，並回 {handled:false}／0 —— 綁定壞掉不可拖垮 webhook 的既有回覆
 */
import { sha256Hex } from "../lib/crypto_util.js";
import { checkRateLimit } from "../middleware/rate_limiter.js";
import { consumeBindCode, upsertContactBinding, markContactsBlockedByUser, restoreContactsByUser, writeAudit } from "./db.js";

export const BIND_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BIND_CONFIRM_TEXT = "已完成綁定，之後會在這裡通知你";

/** Crockford base32（去掉 I、L、O、U），32 個字元，恰為 2^5，所以「取低 5 bit」沒有偏差 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BODY_LENGTH = 8;

/** 綁定碼的完整形狀。i 旗標在非 unicode 模式下不會讓 ſ（U+017F）之類大寫後會變成 ASCII 字母的字元混進來 */
export const BIND_CODE_RE = /^LM-[0-9A-HJKMNP-TV-Z]{8}$/i;

/** 每 (bot, LINE 使用者) 的嘗試次數上限（只有「長得像綁定碼」的訊息才計次） */
const ATTEMPT_RATE_LIMIT = { limit: 10, windowSec: 60 };

/** 產生一組新的綁定碼：`LM-` + 8 碼（約 40 bits，crypto.getRandomValues） */
export function generateBindCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BODY_LENGTH));
  let body = "";
  for (const b of bytes) body += ALPHABET[b & 31];
  return `LM-${body}`;
}

/**
 * 訊息文字若（trim 後、不分大小寫）完全是一組綁定碼，回標準形（大寫）；否則回 null。
 * 不做前綴或模糊比對。
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function normalizeBindCode(text) {
  if (typeof text !== "string" || text.length > 256) return null;
  const t = text.trim();
  return BIND_CODE_RE.test(t) ? t.toUpperCase() : null;
}

const enabled = (env) => Boolean(env) && env.BRIDGE_ENABLED === "1";
const validId = (v) => typeof v === "string" && v !== "" && v.length <= 128;

/**
 * 嘗試把這則文字訊息當作綁定碼消耗。
 *
 * @param {Object} env
 * @param {{botId: string, lineUserId: string, text: string}} input botId 是 webhook 的 destination
 * @returns {Promise<{handled: false} | {handled: true, replyText: string}>} 絕不丟錯
 */
export async function tryConsumeBindCode(env, { botId, lineUserId, text } = {}) {
  try {
    if (!enabled(env)) return { handled: false };
    const code = normalizeBindCode(text);
    if (code === null) return { handled: false };
    if (!validId(botId) || !validId(lineUserId)) return { handled: false };

    const limited = await checkRateLimit(env, `bindattempt.${botId}.${lineUserId}`, ATTEMPT_RATE_LIMIT);
    if (!limited.allowed) return { handled: false };

    const consumed = await consumeBindCode(env, { codeHash: await sha256Hex(code), botId });
    if (!consumed) return { handled: false };

    await upsertContactBinding(env, { linkId: consumed.linkId, ref: consumed.ref, botId, lineUserId });
    // audit 只記 product_id 與 link_id：不含 ref、LINE userId、碼
    await writeAudit(env, {
      actorType: "system", actorId: "webhook", botId, action: "contact_bound", result: "ok",
      detail: { product_id: consumed.productId, link_id: consumed.linkId },
    });
    return { handled: true, replyText: BIND_CONFIRM_TEXT };
  } catch (err) {
    // 只記 message：不記碼、不記 userId、不記 stack
    console.error("[Binding] consume failed:", err && err.message);
    return { handled: false };
  }
}

/**
 * unfollow（被封鎖）：這個 bot 之下、此 LINE 使用者的綁定標成 blocked。
 *
 * @returns {Promise<number>} 受影響的列數；旗標關閉、參數不合或任何錯誤都回 0，絕不丟錯
 */
export async function markBlocked(env, { botId, lineUserId } = {}) {
  try {
    if (!enabled(env) || !validId(botId) || !validId(lineUserId)) return 0;
    return await markContactsBlockedByUser(env, { botId, lineUserId });
  } catch (err) {
    console.error("[Binding] markBlocked failed:", err && err.message);
    return 0;
  }
}

/**
 * follow（解除封鎖）：只把先前綁定過、目前是 blocked 的列還原成 bound；不新建綁定。
 *
 * @returns {Promise<number>} 受影響的列數；旗標關閉、參數不合或任何錯誤都回 0，絕不丟錯
 */
export async function restoreFollow(env, { botId, lineUserId } = {}) {
  try {
    if (!enabled(env) || !validId(botId) || !validId(lineUserId)) return 0;
    return await restoreContactsByUser(env, { botId, lineUserId });
  } catch (err) {
    console.error("[Binding] restoreFollow failed:", err && err.message);
    return 0;
  }
}
