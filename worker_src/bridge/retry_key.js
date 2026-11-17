/**
 * 由冪等鍵衍生 LINE 的 X-Line-Retry-Key（messages.js 與 notify.js 共用）。
 * 從 messages.js 原樣搬出：/raw 的衍生值不變（由既有測試把關）。
 */
import { sha256Hex } from "../lib/crypto_util.js";

/**
 * UUID v4 形狀（LINE 要求 UUID）。綁 (bot, system, key)，同一把永遠相同。
 * 連結金鑰的 system 欄是 `link:{link_id}`（含 ":"，不可能與系統名稱撞名），所以兩種主體的衍生值互不相同。
 *
 * @param {string} botId
 * @param {string} system
 * @param {string} idemKey
 * @returns {Promise<string>}
 */
export async function retryKeyFor(botId, system, idemKey) {
  const h = await sha256Hex(`${botId}|${system}|${idemKey}`);
  const variant = "89ab"[parseInt(h[16], 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
