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
 *
 * M-02（docs/integration/lm-sec-plan.md）：
 *   - 碼 = `LM-` + 12 碼 Crockford base32（60 bit），顯示成 LM-XXXX-XXXX-XXXX，TTL 48 小時；
 *     辨識接受有無連字號、不分大小寫；舊的 8 碼（`LM-XXXXXXXX`）在過渡期內仍可消耗
 *   - 嘗試限流改用 D1 原子計數（bridge/db.js takeToken）：每 (bot, 使用者) 每分鐘 10 次；每 bot 每分鐘最多 30 次
 *     「查無此碼」，超過就暫停辨識該 bot 的綁定碼 5 分鐘（暫停期間不查碼），每 bot 每小時寫一筆稽核 bind_paused
 *   - 覆蓋既有綁定預設拒絕（allow_rebind）：被拒時碼不被消耗、OA 保持沉默、寫稽核 bind_rejected；
 *     allow_rebind = true 才覆蓋，並盡力通知原綁定者
 *   - 缺 0004 遷移（沒有 counters 表）→ 查詢失敗 → 一律不綁定（fail-closed），不是放行
 *   - 任何例外只記 err.message，並回 {handled:false}／0 —— 綁定壞掉不可拖垮 webhook 的既有回覆
 */
import { getBotAccessToken } from "../lm_service.js";
import { sha256Hex } from "../lib/crypto_util.js";
import { pushMessage } from "../lib/line_api.js";
import {
  consumeBindCode, markContactsBlockedByUser, restoreContactsByUser, writeAudit,
  takeToken, giveBackTokens, getFlag, setFlag, claimFlag,
} from "./db.js";

export const BIND_CODE_TTL_MS = 48 * 60 * 60 * 1000;
export const BIND_CONFIRM_TEXT = "已完成綁定，之後會在這裡通知你";
/** 覆蓋既有綁定時，推給「原綁定者」的文字（不含任何識別資訊） */
export const REBIND_NOTICE_TEXT = "你的綁定已被更換";

/** Crockford base32（去掉 I、L、O、U），32 個字元，恰為 2^5，所以「取低 5 bit」沒有偏差 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BODY_LENGTH = 12;
const CH = "[0-9A-HJKMNP-TV-Z]";

/**
 * 綁定碼的完整形狀。i 旗標在非 unicode 模式下不會讓 ſ（U+017F）之類大寫後會變成 ASCII 字母的字元混進來。
 * 新碼：LM- + 3 組各 4 碼，組間連字號可有可無；舊碼：LM- + 8 碼（不接受中間有連字號）。
 */
export const BIND_CODE_RE = new RegExp(`^LM-(?:${CH}{4}-?${CH}{4}-?${CH}{4}|${CH}{8})$`, "i");

/** 每 (bot, LINE 使用者) 每分鐘的嘗試次數上限（只有「長得像綁定碼」的訊息才計次） */
export const USER_ATTEMPT_CAP = 10;
/** 每 bot 每分鐘「查無此碼」的上限；超過 → 暫停辨識 */
export const BOT_FAILURE_CAP = 30;
export const BIND_PAUSE_MS = 5 * 60 * 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 產生一組新的綁定碼（標準形、無連字號）：`LM-` + 12 碼（60 bits，crypto.getRandomValues，無模數偏差） */
export function generateBindCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BODY_LENGTH));
  let body = "";
  for (const b of bytes) body += ALPHABET[b & 31];
  return `LM-${body}`;
}

/** 標準形 → 給人看的形式：`LM-XXXX-XXXX-XXXX`（舊的 8 碼原樣回傳） */
export function formatBindCode(code) {
  const m = /^LM-([0-9A-Z]{4})([0-9A-Z]{4})([0-9A-Z]{4})$/.exec(String(code));
  return m ? `LM-${m[1]}-${m[2]}-${m[3]}` : String(code);
}

/**
 * 訊息文字若（trim 後、不分大小寫）完全是一組綁定碼，回標準形（大寫、無連字號，也就是存雜湊的那個字串）；否則回 null。
 * 不做前綴或模糊比對。
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function normalizeBindCode(text) {
  if (typeof text !== "string" || text.length > 256) return null;
  const t = text.trim();
  return BIND_CODE_RE.test(t) ? t.toUpperCase().replace(/-/g, "").replace(/^LM/, "LM-") : null;
}

const enabled = (env) => Boolean(env) && env.BRIDGE_ENABLED === "1";
const validId = (v) => typeof v === "string" && v !== "" && v.length <= 128;

/** 對原綁定者推「綁定已被更換」。盡力而為：失敗一律吞掉，不記 userId */
async function notifyPreviousBinder(env, botId, previousUserId) {
  try {
    const token = await getBotAccessToken(env, botId);
    if (!token) return;
    await pushMessage(token, previousUserId, [{ type: "text", text: REBIND_NOTICE_TEXT }]);
  } catch (err) {
    console.error("[Binding] rebind notice failed:", err && err.message);
  }
}

/** 暫停這個 bot 的綁定碼辨識 5 分鐘；每 bot 每小時只寫一筆稽核 */
async function pauseBot(env, botId, now) {
  await setFlag(env, { key: `bindpause:${botId}`, untilAt: now + BIND_PAUSE_MS });
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  if (await claimFlag(env, { key: `bindpause_audit:${botId}:${hour}`, untilAt: hour + HOUR_MS, now })) {
    await writeAudit(env, { actorType: "system", actorId: "webhook", botId, action: "bind_paused", result: "blocked" });
  }
}

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

    const now = Date.now();
    // 暫停中：不計數、不查碼
    if (await getFlag(env, { key: `bindpause:${botId}`, now })) return { handled: false };

    const userKey = `binduser:${botId}:${(await sha256Hex(lineUserId)).slice(0, 32)}`;
    const perUser = await takeToken(env, { key: userKey, windowMs: MINUTE_MS, cap: USER_ATTEMPT_CAP, now });
    if (!perUser.allowed) return { handled: false };

    // 每 bot 的「查無此碼」預算：先扣、查到碼（不論成功或被拒）再還。這樣並行猜碼也不會超過上限，
    // 而且正常綁定不吃預算。
    const perBot = await takeToken(env, { key: `bindfail:${botId}`, windowMs: MINUTE_MS, cap: BOT_FAILURE_CAP, now });
    if (!perBot.allowed) {
      await pauseBot(env, botId, now);
      return { handled: false };
    }

    const consumed = await consumeBindCode(env, { codeHash: await sha256Hex(code), botId, lineUserId });
    if (!consumed) return { handled: false };
    try {
      await giveBackTokens(env, [{ key: `bindfail:${botId}`, window: perBot.window }]);
    } catch (err) {
      console.error("[Binding] refund failed:", err && err.message);
    }

    // audit 只記 product_id 與 link_id：不含 ref、LINE userId、碼
    if (consumed.rejected) {
      // 沉默：看起來與「查無此碼」一樣（照原流程走）；碼沒有被消耗
      await writeAudit(env, {
        actorType: "system", actorId: "webhook", botId, action: "bind_rejected", result: "blocked",
        detail: { product_id: consumed.productId, link_id: consumed.linkId },
      });
      return { handled: false };
    }
    await writeAudit(env, {
      actorType: "system", actorId: "webhook", botId, action: "contact_bound", result: "ok",
      detail: { product_id: consumed.productId, link_id: consumed.linkId },
    });
    if (consumed.previousUserId) await notifyPreviousBinder(env, botId, consumed.previousUserId);
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
