/**
 * 系統管理頁的純邏輯（驗證、請求內容、說明文字）。
 *
 * 刻意不碰 DOM、window、config —— 這樣才能在 node 下做單元測試。
 * 規則要與後端 worker_src/handler/systems.js 保持一致：畫面上填得過、
 * 送出去才被拒，是最糟的體驗。
 */

const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const NAME_MAX = 100;

/**
 * 權限範圍。available=false 的在後端已定義、但還沒有對應的端點，
 * 畫面上標示「尚未開放」且不可勾選，避免發出一把「看起來有權限、實際沒用」的 key。
 */
export const SCOPES = [
  { id: 'messages:push', label: '推播訊息（push / multicast）', available: true },
  { id: 'members:read', label: '讀取會員資料', available: false },
  { id: 'tags:write', label: '寫入會員標籤', available: false },
];

const AVAILABLE_SCOPE_IDS = new Set(SCOPES.filter((s) => s.available).map((s) => s.id));

/** 輸入時不必糾結大小寫與前後空白：先整理再驗證 */
function normalizeId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * @returns {{valid: boolean, message?: string}}
 */
export function validateSystemId(value) {
  const id = normalizeId(value);
  if (typeof id !== 'string' || id === '') {
    return { valid: false, message: '請輸入系統代號' };
  }
  if (!SYSTEM_ID_RE.test(id)) {
    return {
      valid: false,
      message: '代號只能用小寫英文、數字、- 與 _，長度 2–32，且要以英文或數字開頭',
    };
  }
  return { valid: true };
}

/**
 * 整理表單並驗證，回傳可以直接 POST 的內容。
 * 不帶 webhookUrl / events：事件轉發尚未開放，送了也不會有作用。
 *
 * @param {{system?: string, name?: string, scopes?: string[]}} form
 * @returns {{ok: true, payload: {system: string, name: string, scopes: string[]}} | {ok: false, field: string, error: string}}
 */
export function buildCreatePayload(form = {}) {
  const idCheck = validateSystemId(form.system);
  if (!idCheck.valid) return { ok: false, field: 'system', error: idCheck.message };

  const name = typeof form.name === 'string' ? form.name.trim() : '';
  if (name === '') return { ok: false, field: 'name', error: '請輸入系統名稱' };
  if (name.length > NAME_MAX) return { ok: false, field: 'name', error: `名稱最多 ${NAME_MAX} 字` };

  const scopes = [...new Set(Array.isArray(form.scopes) ? form.scopes : [])].filter((s) => AVAILABLE_SCOPE_IDS.has(s));
  if (scopes.length === 0) return { ok: false, field: 'scopes', error: '請至少勾選一個權限' };

  return { ok: true, payload: { system: normalizeId(form.system), name, scopes } };
}

/** 只接受 LINE id 常見的字元，其餘一律用佔位符，避免破壞範例的 shell 引號 */
function safeBotId(botId) {
  return typeof botId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(botId) ? botId : '<BOT_ID>';
}

/**
 * 呼叫範例。金鑰永遠是佔位符 —— 真正的 key 只在建立當下顯示一次，不該進任何範例或紀錄。
 */
export function buildCurlExample(baseUrl, botId) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return [
    `curl -X POST ${base}/bridge/v1/raw/push \\`,
    '  -H "Authorization: Bearer <API_KEY>" \\',
    `  -H "X-Bot-Id: ${safeBotId(botId)}" \\`,
    '  -H "X-Idempotency-Key: <同一件事用同一個字串>" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"to":"<LINE_USER_ID>","messages":[{"type":"text","text":"hello"}]}'`,
  ].join('\n');
}

/**
 * 後端錯誤 → 給人看的說明。500 與未知狀態不回傳後端細節。
 *
 * @param {number} status
 * @param {{error?: string}|null} body
 */
export function describeError(status, body) {
  const detail = body && typeof body.error === 'string' ? body.error : '';
  switch (status) {
    case 400:
      return detail ? `輸入有誤：${detail}` : '輸入有誤，請檢查後再試';
    case 401:
      return '登入已失效，請重新整理頁面並重新登入';
    case 403:
      return '只有管理員（owner）可以管理系統整合';
    case 404:
      return '找不到這個系統，可能已被刪除';
    case 409:
      return '這個系統代號已經註冊過了，請換一個';
    default:
      return '發生錯誤，請稍後再試';
  }
}
