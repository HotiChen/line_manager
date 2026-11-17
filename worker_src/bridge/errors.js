/**
 * bridge-v1 新錯誤格式 helper（決定 D-7）
 *
 *   { "error": { "code": "<ENUM>", "message": "...", "retryable": true|false } }
 *
 * code 限 docs/integration/bridge-v1.yaml 的 Error schema enum。
 *
 * 【本檔刻意尚未接線】/bridge/v1/raw/*、/bridge/v1/systems* 依 D-7 維持舊格式
 * `{success:false,error:"..."}`（既有測試不可改弱）。本 helper 只供 LM-2A 以後的新端點使用。
 *
 * 未知 code 直接丟錯：那是程式錯誤，不可默默吐出不在契約內的字串。
 * message 只取第一行，避免有人誤把 err.stack 傳進來；回應永遠不含 stack。
 */

/** code → 預設 HTTP status 與 retryable（與 bridge-v1.yaml 各 response 說明一致） */
export const ERROR_DEFAULTS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      INVALID_KEY: { status: 401, retryable: false },
      LINK_REVOKED: { status: 403, retryable: false },
      SCOPE_DENIED: { status: 403, retryable: false },
      INVALID_CODE: { status: 400, retryable: false },
      INVALID_REQUEST: { status: 400, retryable: false },
      CONTACT_NOT_BOUND: { status: 409, retryable: false },
      RECIPIENT_BLOCKED: { status: 409, retryable: false },
      INVALID_URL_DOMAIN: { status: 422, retryable: false },
      IN_PROGRESS: { status: 409, retryable: true },
      IDEMPOTENCY_KEY_REUSE: { status: 422, retryable: false },
      NOT_FOUND: { status: 404, retryable: false },
      QUOTA_EXCEEDED: { status: 402, retryable: false },
      RATE_LIMITED: { status: 429, retryable: true },
      INTERNAL: { status: 500, retryable: true },
    }).map(([k, v]) => [k, Object.freeze(v)])
  )
);

export const ERROR_CODES = Object.freeze(Object.keys(ERROR_DEFAULTS));

/**
 * @param {string} code ERROR_CODES 之一
 * @param {string} message 給人看的說明（只取第一行）
 * @param {{status?: number, retryable?: boolean, headers?: Record<string,string>}} [opts]
 * @returns {Response}
 */
export function bridgeError(code, message, opts = {}) {
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(ERROR_DEFAULTS, code)) {
    throw new Error(`unknown bridge error code: ${String(code)}`);
  }
  if (typeof message !== "string") throw new TypeError("bridgeError: message must be a string");
  const { status = ERROR_DEFAULTS[code].status, retryable = ERROR_DEFAULTS[code].retryable, headers } = opts || {};
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError("bridgeError: status must be an HTTP error status (400-599)");
  }
  const firstLine = message.split(/\r?\n/, 1)[0];
  const res = new Response(
    JSON.stringify({ error: { code, message: firstLine, retryable: Boolean(retryable) } }),
    { status, headers: { "Content-Type": "application/json", ...(headers || {}) } }
  );
  res.headers.set("Content-Type", "application/json");
  return res;
}
