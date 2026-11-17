/**
 * 產品連結（LM-2A）前端的純邏輯：同意頁與後台「已連結的產品」共用。
 *
 * 刻意不碰 DOM、window、config —— 這樣才能在 node 下做單元測試。
 * 對應後端 worker_src/bridge/links.js；規格見 docs/integration/lm-2a-plan.md 第 3、7、8 節。
 *
 * 安全重點：
 *   - product_id / state / redirect_uri 都是外部輸入，這裡只負責整理與驗證，不做任何輸出
 *   - 導向前一律經 validateRedirectTarget（只允許 https、同 origin、同 path、無帳號密碼）
 *   - 不認識的 scope 不顯示原字串（避免外部輸入進畫面），並讓「同意」無法按
 */

// ── scope ──

/** 連結流程的三個 scope（與後端 worker_src/bridge/scopes.js 的 LINK_SCOPES 一致） */
const SCOPE_TEXT = Object.freeze({
  'link:manage': { long: '管理這個連結（查看狀態、解除、更換金鑰）', short: '管理連結' },
  'contacts:bind': { long: '為你的客戶產生綁定碼', short: '產生綁定碼' },
  'messages:send': { long: '向已綁定的客戶發送通知', short: '發送通知' },
});

export const UNKNOWN_SCOPE_TEXT = '未知權限';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function describeOne(scope, form) {
  return typeof scope === 'string' && hasOwn(SCOPE_TEXT, scope)
    ? { id: scope, text: SCOPE_TEXT[scope][form], known: true }
    : { id: null, text: UNKNOWN_SCOPE_TEXT, known: false }; // 絕不回傳原字串
}

/**
 * 同意頁用：scope → 白話說明（長版）。
 *
 * @param {unknown} scopes
 * @returns {{items: Array<{id: string|null, text: string, known: boolean}>, hasUnknown: boolean, canApprove: boolean}}
 *   canApprove：至少有一個 scope、而且全部認得；否則同意按鈕必須停用
 */
export function describeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  const items = list.map((s) => describeOne(s, 'long'));
  const hasUnknown = items.some((i) => !i.known);
  return { items, hasUnknown, canApprove: items.length > 0 && !hasUnknown };
}

/** 後台用：scope → 短標籤 */
export function scopeShortLabel(scope) {
  return describeOne(scope, 'short').text;
}

// ── 查詢參數與 sessionStorage 備援 ──

export const AUTH_PARAM_KEYS = Object.freeze(['product_id', 'state', 'redirect_uri']);
export const AUTH_STORAGE_KEY = 'lm_link_authorize_params';

function pickParams(getter) {
  const out = {};
  for (const key of AUTH_PARAM_KEYS) {
    const v = getter(key);
    if (typeof v !== 'string' || v === '') return null;
    out[key] = v;
  }
  return out;
}

/**
 * 從查詢字串讀三個參數。缺任何一個（或是空字串）→ null。
 *
 * @param {string} search 例如 window.location.search
 * @returns {{product_id: string, state: string, redirect_uri: string} | null}
 */
export function readAuthParams(search) {
  let q;
  try {
    q = new URLSearchParams(typeof search === 'string' ? search : '');
  } catch {
    return null;
  }
  return pickParams((k) => q.get(k));
}

/** 儲存失敗（沒有 storage、隱私模式、額度滿）一律吞掉：頁面仍可運作，只是登入後可能要重新由產品導入 */
export function saveAuthParams(storage, params) {
  try {
    const clean = pickParams((k) => params && params[k]);
    if (!storage || !clean) return false;
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

export function clearAuthParams(storage) {
  try {
    if (storage) storage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // 沒有 storage 也不影響流程
  }
}

/** 讀出備援參數並「立即清掉」。格式不對一律當沒有（也清掉）。 */
export function restoreAuthParams(storage) {
  let raw = null;
  try {
    raw = storage ? storage.getItem(AUTH_STORAGE_KEY) : null;
  } catch {
    return null;
  }
  clearAuthParams(storage);
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? pickParams((k) => parsed[k]) : null;
  } catch {
    return null;
  }
}

/**
 * 取得本次授權參數：網址優先；網址不完整才用 sessionStorage 備援。
 * 不論用了哪一邊，備援資料都會被清掉（避免舊參數在下一次開頁時復活）。
 *
 * @returns {{product_id: string, state: string, redirect_uri: string} | null}
 */
export function resolveAuthParams(search, storage) {
  const fromUrl = readAuthParams(search);
  if (fromUrl) {
    clearAuthParams(storage);
    return fromUrl;
  }
  return restoreAuthParams(storage);
}

// ── 導向驗證 ──

function parseUrl(value) {
  if (typeof value !== 'string' || value === '' || value.length > 4096) return null;
  // URL 解析器會默默吃掉前後的空白與控制字元（\u0000https://… 也解析得出來）；後端產生的網址不會有這些
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    return new URL(value); // 不給 base：相對路徑、javascript: 之類都在這裡或下面被擋
  } catch {
    return null;
  }
}

/**
 * 導向前驗證（防 open redirect、防被竄改的 redirect_to）。
 * 全部成立才回 ok：
 *   - 兩者都能解析，且協定都是 https:
 *   - 沒有帳號密碼（https://good.example@evil.example 之類）、沒有 fragment
 *   - origin + pathname 與原本的 redirect_uri 完全相同（query 可以不同：code／state／error 在這裡）
 *
 * @param {unknown} target 後端回的 redirect_to 或 cancel_redirect_to
 * @param {unknown} originalRedirectUri 網址上的 redirect_uri
 * @returns {{ok: true, url: string} | {ok: false}}
 */
export function validateRedirectTarget(target, originalRedirectUri) {
  const t = parseUrl(target);
  const o = parseUrl(originalRedirectUri);
  if (!t || !o) return { ok: false };
  if (t.protocol !== 'https:' || o.protocol !== 'https:') return { ok: false };
  if (t.username || t.password || o.username || o.password) return { ok: false };
  if (t.hash) return { ok: false };
  if (t.origin !== o.origin || t.pathname !== o.pathname) return { ok: false };
  return { ok: true, url: t.href };
}

// ── 後端回應 ──

/**
 * 整理 preview 回應。形狀不對回 null（頁面顯示通用錯誤），不要硬撐。
 *
 * @returns {{productName: string, scopes: unknown[], bots: Array<{botId: string, displayName: string}>, cancelRedirectTo: string} | null}
 */
export function parsePreview(data) {
  if (!data || typeof data !== 'object') return null;
  const name = data.product && typeof data.product.name === 'string' ? data.product.name : '';
  if (name === '' || !Array.isArray(data.scopes) || !Array.isArray(data.bots)) return null;
  const bots = data.bots
    .filter((b) => b && typeof b.bot_id === 'string' && b.bot_id !== '')
    .map((b) => ({ botId: b.bot_id, displayName: typeof b.display_name === 'string' && b.display_name !== '' ? b.display_name : b.bot_id }));
  return {
    productName: name,
    scopes: data.scopes,
    bots,
    cancelRedirectTo: typeof data.cancel_redirect_to === 'string' ? data.cancel_redirect_to : '',
  };
}

/** 送 approve 的 body。只含四個欄位；bot_id 由呼叫端傳入（來自 preview 的清單，後端仍會檢查 owner） */
export function buildApprovePayload(params, botId) {
  return {
    product_id: params.product_id,
    state: params.state,
    redirect_uri: params.redirect_uri,
    bot_id: botId,
  };
}

// ── 錯誤訊息 ──

/**
 * 新端點錯誤（{error:{code,message,retryable}}）→ 中文說明。
 * 只看 code 與 HTTP status，不顯示後端 message（避免把細節或外部字串丟到畫面上）。
 *
 * @param {number} status 0 代表網路失敗
 * @param {unknown} body 解析後的回應；解析失敗為 null
 * @param {'authorize'|'admin'} [context]
 */
export function describeLinkError(status, body, context = 'authorize') {
  const code = body && typeof body === 'object' && body.error && typeof body.error === 'object' && typeof body.error.code === 'string'
    ? body.error.code
    : '';
  if (status === 0) return '無法連線到伺服器，請檢查網路後再試';
  switch (code) {
    case 'INVALID_REQUEST':
      return context === 'admin' ? '請求有誤，請重新整理頁面後再試' : '連結已失效或參數錯誤，請回到產品重新開始';
    case 'INVALID_KEY':
      return '登入已失效，請重新登入';
    case 'RATE_LIMITED':
      return '操作太頻繁，請稍後再試';
    case 'NOT_FOUND':
      return context === 'admin' ? '找不到這個官方帳號或連結，或你沒有權限' : '找不到這個官方帳號，或你沒有權限';
    case 'INTERNAL':
      return '服務暫時無法使用，請稍後再試';
    default:
      break;
  }
  if (status === 429) return '操作太頻繁，請稍後再試';
  if (status >= 500) return '服務暫時無法使用，請稍後再試';
  return '發生未知錯誤';
}

// ── 後台列表 ──

/**
 * 整理 GET /admin/links 的回應。壞資料列直接略過；排序：使用中在前，其次依連結時間新到舊。
 *
 * @returns {Array<{linkId: string, productName: string, status: 'active'|'revoked', scopes: string[], createdAt: string|null, revokedAt: string|null}>}
 */
export function normalizeLinks(data) {
  const rows = data && Array.isArray(data.links) ? data.links : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r.link_id !== 'string' || r.link_id === '') continue;
    if (r.status !== 'active' && r.status !== 'revoked') continue;
    out.push({
      linkId: r.link_id,
      productName: typeof r.product_name === 'string' && r.product_name !== '' ? r.product_name : '（未命名產品）',
      status: r.status,
      scopes: Array.isArray(r.scopes) ? r.scopes : [],
      createdAt: typeof r.created_at === 'string' ? r.created_at : null,
      revokedAt: typeof r.revoked_at === 'string' ? r.revoked_at : null,
    });
  }
  const time = (s) => {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  return out.sort((a, b) => (a.status === b.status ? time(b.createdAt) - time(a.createdAt) : a.status === 'active' ? -1 : 1));
}

/** ISO 時間字串 → 台灣時間顯示；沒有或不合法 → 「—」 */
export function formatIsoTime(iso) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('zh-TW', { hour12: false });
}
