/**
 * 客人分眾（LM-4D）：分眾變更後，把這位 LINE 使用者的分眾清單同步到 LM 並重新計算 Rich Menu。
 *
 * 分眾的真相在 D1（contacts.segment）。LM 端（4R 的 syncMemberRichMenu）讀 KV 會員資料的副本
 * productSegments —— 因為 LM 的 lib/ 不能 import bridge/，所以由這裡在每次變更後經 lm_service 寫入。
 *
 * 不變量：
 *   - HTTP 處理檔（contacts.js、links.js）不碰 LINE userId：它們只拿到這裡回的不透明 handle
 *   - 重新計算失敗不影響呼叫端（PUT 仍回 204）：重試 3 次（0／1／3 秒），最後只記 message
 *   - 不記 LINE userId、分眾值、Rich Menu id
 */
import { applyProductSegments } from "../lm_service.js";
import { listSegmentRecipients, listUserSegments, listLinksForBot, writeAudit } from "./db.js";

/** 分眾名稱（草案 §D.2） */
export const SEGMENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 一次撤銷／取代最多重新計算這麼多人；超過的寫一筆稽核，等下次標籤變更或加好友時自然更新 */
export const MAX_REFRESH_PER_EVENT = 200;

const RETRY_DELAYS_MS = [1000, 3000];
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = realSleep;

/** 測試用：把重試的等待換掉（傳 null 還原） */
export function setRetrySleepForTest(fn) {
  sleep = typeof fn === "function" ? fn : realSleep;
}

/**
 * 有 ctx.waitUntil 就放進去（回應不等）；沒有就直接等完（測試、或呼叫端本來就在背景）。
 *
 * @param {{waitUntil?: Function}|undefined} ctx
 * @param {Promise<unknown>} promise
 */
export async function defer(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

/**
 * 重新算出這位使用者在這個 bot 的分眾，寫進 LM 並重新計算 Rich Menu。絕不丟錯。
 *
 * @param {Object} env
 * @param {string} botId
 * @param {string} lineUserId
 * @param {{retries?: number, sync?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export async function refreshUserSegments(env, botId, lineUserId, { retries = RETRY_DELAYS_MS.length, sync = true } = {}) {
  let segments;
  try {
    segments = await listUserSegments(env, { botId, lineUserId });
  } catch (err) {
    console.error("[Segments] list failed:", err && err.message);
    return false;
  }
  for (let attempt = 0; ; attempt++) {
    if (await applyProductSegments(env, botId, lineUserId, segments, { sync })) return true;
    if (attempt >= retries) break;
    await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
  }
  console.error("[Segments] rich menu refresh gave up");
  return false;
}

/**
 * 封鎖時用：markFn 會把這位使用者的綁定標成 blocked（同一句清掉分眾）。
 * 只有原本真的有分眾時才更新 LM 的副本（不呼叫 LINE：封鎖中切不了選單）。
 *
 * @param {Object} env
 * @param {string} botId
 * @param {string} lineUserId
 * @param {() => Promise<number>} markFn
 * @returns {Promise<number>} markFn 的回傳值
 */
export async function blockAndClearSegments(env, botId, lineUserId, markFn) {
  let had = false;
  try {
    had = (await listUserSegments(env, { botId, lineUserId })).length > 0;
  } catch (err) {
    console.error("[Segments] list failed:", err && err.message);
  }
  const n = await markFn();
  if (n > 0 && had) await refreshUserSegments(env, botId, lineUserId, { retries: 0, sync: false });
  return n;
}

/**
 * 對一組對象逐一重新計算。handle 由下面的 capture* 產生。
 *
 * @param {Object} env
 * @param {{recipients: {botId: string, lineUserId: string}[]}|null} handle
 */
export async function refreshRecipients(env, handle) {
  if (!handle || !Array.isArray(handle.recipients)) return;
  for (const r of handle.recipients) {
    await refreshUserSegments(env, r.botId, r.lineUserId);
  }
}

async function capture(env, { linkId, ref = null, onlySegmented }, audit) {
  const rows = await listSegmentRecipients(env, { linkId, ref, onlySegmented, limit: MAX_REFRESH_PER_EVENT + 1 });
  if (rows.length > MAX_REFRESH_PER_EVENT && audit) {
    await writeAudit(env, {
      actorType: "system", actorId: "segments", botId: audit.botId, action: "segment_refresh_truncated", result: "blocked",
      detail: { product_id: audit.productId, link_id: linkId, count: MAX_REFRESH_PER_EVENT },
    });
  }
  return rows.slice(0, MAX_REFRESH_PER_EVENT);
}

/** 這條連結下某個 ref 的綁定者（設定分眾後、解除綁定前用） */
export async function captureContactRecipients(env, { linkId, ref, onlySegmented = false }) {
  return { recipients: await capture(env, { linkId, ref, onlySegmented }) };
}

/** 這條連結下目前有分眾的人（撤銷前用；撤銷會清掉分眾） */
export async function captureLinkRecipients(env, linkId, audit = null) {
  return { recipients: await capture(env, { linkId, onlySegmented: true }, audit) };
}

/** 同 (product, bot) 目前 active 的連結下有分眾的人（重新授權取代前用；搬家會清掉分眾） */
export async function captureReplacedRecipients(env, { productId, botId }) {
  const links = await listLinksForBot(env, botId);
  const recipients = [];
  for (const l of links) {
    if (l.productId !== productId || l.status !== "active") continue;
    recipients.push(...(await capture(env, { linkId: l.linkId, onlySegmented: true }, { botId, productId })));
  }
  return { recipients };
}
