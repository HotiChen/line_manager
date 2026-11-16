/**
 * 每個 bot 自己的 LINE channel secret
 *
 * 為什麼存在：webhook 簽章密鑰原本只有一個全域的 LINE_CHANNEL_SECRET，但每個 LINE
 * channel 的 secret 都不同，所以只有 secret 剛好相同的那個官方帳號的 webhook 驗得過，
 * 其他一律 401。
 *
 * 存在 bot:${botId}:credential 底下（BotKeys.credential），AES-GCM 加密（沿用 token_crypto）。
 * botId 就是 LINE 的 destination。
 *
 * 規則：
 *   - 存：格式驗證（32 位十六進位）、缺加密金鑰時丟錯、不降級存明文、不覆蓋同一筆裡的其他欄位
 *   - 讀：任何失敗（沒設定、資料損毀、密文被改、金鑰換了、botId 不合法）一律回 null，不丟例外 ——
 *     webhook 路徑不可因為一筆壞資料變成 500，而是退回既有的全域密鑰行為
 */
import { BotKeys } from "./kv_schema.js";
import { encryptToken, decryptToken } from "./token_crypto.js";

const CHANNEL_SECRET_RE = /^[0-9a-f]{32}$/i;

/** LINE channel secret 是 32 位十六進位字串 */
export function isValidChannelSecret(value) {
  return typeof value === "string" && CHANNEL_SECRET_RE.test(value);
}

/**
 * @param {Object} env - 需含 KV_LINE_STORAGE 與 TOKEN_ENCRYPTION_KEY
 * @param {string} botId
 * @param {string} secret
 * @throws 格式不合法、botId 不合法、缺加密金鑰、缺 KV
 */
export async function saveChannelSecret(env, botId, secret) {
  if (!isValidChannelSecret(secret)) {
    throw new TypeError("invalid channel secret format (expected 32 hex characters)");
  }
  if (!env?.KV_LINE_STORAGE) throw new Error("KV binding missing");

  const key = BotKeys.credential(botId); // botId 含 ':' 時在這裡丟錯，不會寫到別人的命名空間
  const sealed = await encryptToken(env, secret); // 缺金鑰時丟錯，不降級

  const existing = await env.KV_LINE_STORAGE.get(key, { type: "json" });
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};

  await env.KV_LINE_STORAGE.put(
    key,
    JSON.stringify({ ...base, channelSecret: sealed, channelSecretUpdatedAt: Date.now() })
  );
}

/**
 * @returns {Promise<string|null>} 明文密鑰；讀不到或解不開一律 null
 */
export async function getChannelSecret(env, botId) {
  try {
    if (!env?.KV_LINE_STORAGE) return null;
    const record = await env.KV_LINE_STORAGE.get(BotKeys.credential(botId), { type: "json" });
    if (!record || typeof record.channelSecret !== "string") return null;
    const plain = await decryptToken(env, record.channelSecret);
    return isValidChannelSecret(plain) ? plain : null;
  } catch {
    return null;
  }
}

export async function hasChannelSecret(env, botId) {
  return (await getChannelSecret(env, botId)) !== null;
}
