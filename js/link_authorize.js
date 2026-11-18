/**
 * 產品連結同意頁（LM-2A-2）。
 *
 * 流程（docs/integration/lm-2a-plan.md 第 3 節）：
 *   產品 → GET /bridge/v1/link/authorize（Worker 302）→ 本頁 → preview → 使用者按同意 → approve → 導回產品
 *
 * 安全規則（不可退步）：
 *   - 被嵌進 iframe 時什麼都不渲染（防點擊劫持）
 *   - product_id / state / code 一律不進 console、不進 DOM；redirect_uri 只有「主機名稱」會顯示（純文字 textContent，不是連結，M-03）；產品名稱以 textContent 顯示
 *   - 導向前一律經 validateRedirectTarget：只允許 https、同 origin、同 path，無帳號密碼
 *   - 不使用 innerHTML：所有動態內容用 createElement / textContent
 *   - 不認識的 scope 不顯示原字串，且同意按鈕停用
 *   - 按鈕按下後立即 disabled，避免重複送出
 */
import { liffId } from '../env/config.js';
import { ApiClient } from '../helper/api.client.js';
import {
  resolveAuthParams,
  saveAuthParams,
  describeScopes,
  validateRedirectTarget,
  parsePreview,
  buildApprovePayload,
  describeLinkError,
  redirectHostLabel,
  consentNotice,
} from '../helper/link_authorize_form.js';

const byId = (id) => document.getElementById(id);

/** top === self 以外一律視為被嵌入；跨網域 iframe 取 window.top 不會丟錯，但仍包 try/catch 以防萬一 */
function isTopLevel() {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

function getStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null; // 沒有 storage 時頁面仍可運作
  }
}

function applyStoredTheme() {
  try {
    const theme = window.localStorage.getItem('theme');
    if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  } catch {
    // 沒有 localStorage：沿用系統偏好（CSS 的 prefers-color-scheme）
  }
}

// ── 畫面狀態 ──

const STATES = ['state-loading', 'state-consent', 'state-redirecting', 'state-error'];

function show(stateId) {
  for (const id of STATES) byId(id).classList.toggle('d-none', id !== stateId);
}

function showError(message) {
  byId('error-message').textContent = message;
  show('state-error');
}

function showActionError(message) {
  const el = byId('action-error');
  el.textContent = message || '';
  el.classList.toggle('d-none', !message);
}

// ── API ──

/** 回傳 { ok, status, data }；網路失敗 status 為 0。新端點的錯誤 body 自己解析（ErrorHandler 只認得部分 status）。 */
async function call(method, path, body) {
  try {
    const res = await ApiClient.request(method, path, body ?? null, { rawResponse: true, showErrorToast: false });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// ── 同意畫面 ──

const view = {
  params: null,
  preview: null,
  canApprove: false,
  botId: '',
  busy: false,
};

function refreshButtons() {
  byId('btn-approve').disabled = view.busy || !view.canApprove || !view.botId;
  byId('btn-cancel').disabled = view.busy;
}

function renderScopes(desc) {
  const list = byId('scope-list');
  list.replaceChildren();
  const items = desc.items.length > 0 ? desc.items : [{ text: '沒有任何有效的權限', known: false }];
  for (const item of items) {
    const li = document.createElement('li');
    if (!item.known) li.className = 'is-unknown';
    const icon = document.createElement('i');
    icon.className = item.known ? 'bi bi-check2-circle' : 'bi bi-exclamation-triangle-fill';
    const text = document.createElement('span');
    text.textContent = item.text;
    li.append(icon, text);
    list.append(li);
  }
  byId('scope-unknown').classList.toggle('d-none', desc.canApprove);
}

function renderBots(bots) {
  const single = byId('bot-single');
  const select = byId('bot-select');
  const empty = byId('bot-empty');
  single.classList.add('d-none');
  select.classList.add('d-none');
  empty.classList.add('d-none');
  view.botId = '';

  if (bots.length === 0) {
    empty.classList.remove('d-none');
    return;
  }
  if (bots.length === 1) {
    single.textContent = bots[0].displayName;
    single.classList.remove('d-none');
    view.botId = bots[0].botId; // 只有一個就預選
    return;
  }
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '請選擇官方帳號';
  placeholder.selected = true;
  select.append(placeholder);
  for (const bot of bots) {
    const opt = document.createElement('option');
    opt.value = bot.botId;
    opt.textContent = bot.displayName;
    select.append(opt);
  }
  select.classList.remove('d-none');
}

/** 「授權後，你的客戶可綁定並收到來自 {OA 名} 的通知」：隨所選的官方帳號更新（外部輸入，只用 textContent） */
function renderNotice() {
  const bots = view.preview ? view.preview.bots : [];
  const bot = bots.find((b) => b.botId === view.botId);
  byId('consent-notice').textContent = consentNotice(bot ? bot.displayName : '');
}

function renderConsent(preview) {
  byId('product-name').textContent = preview.productName; // 外部輸入：只用 textContent
  byId('redirect-host').textContent = redirectHostLabel(view.params && view.params.redirect_uri) || '（無法辨識）'; // 只顯示主機名稱，不做成連結
  const desc = describeScopes(preview.scopes);
  view.canApprove = desc.canApprove;
  renderScopes(desc);
  renderBots(preview.bots);
  renderNotice();
  showActionError('');
  refreshButtons();
  show('state-consent');
}

// ── 動作 ──

function navigate(url) {
  show('state-redirecting');
  window.location.replace(url);
}

async function onApprove() {
  if (view.busy || !view.canApprove || !view.botId) return;
  view.busy = true;
  refreshButtons(); // 立即 disabled，防重複送出
  showActionError('');

  const res = await call('POST', '/bridge/v1/link/authorize/approve', buildApprovePayload(view.params, view.botId));
  if (!res.ok) {
    view.busy = false;
    refreshButtons();
    showActionError(describeLinkError(res.status, res.data));
    return;
  }

  const target = validateRedirectTarget(res.data && res.data.redirect_to, view.params.redirect_uri);
  if (!target.ok) {
    // 回應被竄改或異常：不導向，也不讓使用者再按
    showError('回傳的導向位址不安全，已停止。請回到產品重新開始。');
    return;
  }
  navigate(target.url); // busy 維持 true：導向期間按鈕保持停用
}

function onCancel() {
  if (view.busy) return;
  view.busy = true;
  refreshButtons();

  const target = validateRedirectTarget(view.preview.cancelRedirectTo, view.params.redirect_uri);
  if (!target.ok) {
    view.busy = false;
    refreshButtons();
    showActionError('無法安全地返回產品，請直接關閉這個頁面。');
    return;
  }
  navigate(target.url);
}

// ── 進入點 ──

async function start() {
  try {
    // eslint-disable-next-line no-undef
    await liff.init({ liffId });
  } catch {
    showError('登入服務暫時無法使用，請稍後再試。');
    return;
  }

  // liff.init 之後再讀：LIFF 可能在這一步把網址還原成原始查詢字串
  const storage = getStorage();
  const params = resolveAuthParams(window.location.search, storage);
  if (!params) {
    showError('缺少必要的授權參數，請回到產品重新開始。');
    return; // 不呼叫 API、不導向
  }

  // eslint-disable-next-line no-undef
  if (!liff.isLoggedIn()) {
    // 登入會離開本頁；先存起來，登入回來若網址沒帶參數就從這裡還原
    saveAuthParams(storage, params);
    // eslint-disable-next-line no-undef
    liff.login();
    return;
  }

  view.params = params;
  const qs = new URLSearchParams(params).toString();
  const res = await call('GET', `/bridge/v1/link/authorize/preview?${qs}`);
  if (!res.ok) {
    showError(describeLinkError(res.status, res.data));
    return;
  }
  const preview = parsePreview(res.data);
  if (!preview) {
    showError('發生未知錯誤');
    return;
  }
  view.preview = preview;
  renderConsent(preview);
}

function init() {
  if (!isTopLevel()) {
    // 被嵌入 iframe：移除內容，只留 HTML 裡的提示文字
    document.documentElement.classList.add('framed');
    byId('auth-card')?.remove();
    return;
  }

  applyStoredTheme();
  byId('btn-approve').addEventListener('click', onApprove);
  byId('btn-cancel').addEventListener('click', onCancel);
  byId('bot-select').addEventListener('change', (e) => {
    view.botId = e.target.value;
    renderNotice();
    refreshButtons();
  });
  // 從產品按「上一頁」回來時，頁面可能是從 bfcache 還原、按鈕卡在停用：重新載入最單純
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) window.location.reload();
  });

  start().catch(() => showError('發生未知錯誤'));
}

init();
