/**
 * 系統整合管理頁
 *
 * 讓 bot 的管理員（owner）註冊、停用、輪替、刪除「系統」（接到這個 LINE 官方帳號上的
 * 垂直後端），並取得 service key。對應後端 worker_src/bridge/systems.js。
 *
 * 安全規則：
 *   - 不使用 innerHTML：所有動態內容用 createElement / textContent 組出來
 *   - API key 只在建立／輪替當下顯示一次，只放在唯讀欄位，對話框關閉就清掉；
 *     不寫 localStorage、不進 console、不存在模組變數
 *   - 錯誤訊息一律經 describeError，不把後端細節直接丟給使用者
 */
import { ApiClient } from '../helper/api.client.js';
import { toast } from '../helper/toast.js';
import { showConfirm } from '../helper/modal.helper.js';
import { apiBase } from '../helper/state.js';
import { SCOPES, validateSystemId, buildCreatePayload, buildCurlExample, describeError } from '../helper/system_form.js';
import { normalizeLinks, scopeShortLabel, formatIsoTime, describeLinkError, buildFallbackPayload, describeFallbackError } from '../helper/link_authorize_form.js';

let botId = null;
let busy = false;

// ── 小工具 ──

/** 組 DOM。字串子節點一律當文字，不會被解析成 HTML。 */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) el.append(child);
  }
  return el;
}

/** 回傳 { ok, status, data }，網路失敗時 status 為 0。不丟例外，也不自動跳 toast。 */
async function call(method, path, body, customHeaders) {
  try {
    const res = await ApiClient.request(method, path, body ?? null, { rawResponse: true, showErrorToast: false, customHeaders });
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

const byId = (id) => document.getElementById(id);

function formatDate(ts) {
  if (typeof ts !== 'number') return '—';
  return new Date(ts).toLocaleString('zh-TW', { hour12: false });
}

function scopeLabel(id) {
  // 過渡期：舊資料列可能還是舊名 messages:push，顯示成 raw:push
  const found = SCOPES.find((s) => s.id === (id === 'messages:push' ? 'raw:push' : id));
  return found ? found.label : id;
}

/** 放進確認對話框前，只信任通過格式驗證的代號（showConfirm 會把訊息當 HTML 插入） */
function safeName(system) {
  return validateSystemId(system).valid ? `「${system}」` : '這個系統';
}

function modal(id) {
  return window.bootstrap.Modal.getOrCreateInstance(byId(id));
}

async function withBusy(button, fn) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  try {
    await fn();
  } finally {
    busy = false;
    if (button) button.disabled = false;
  }
}

// ── 畫面 ──

function showNotice(message) {
  const el = byId('system-notice');
  el.textContent = message;
  el.classList.remove('d-none');
}

function renderScopes() {
  const box = byId('system-scopes');
  box.replaceChildren(
    ...SCOPES.map((s) => {
      const inputId = `scope-${s.id.replace(':', '-')}`;
      return h(
        'div',
        { class: 'form-check' },
        h('input', {
          class: 'form-check-input',
          type: 'checkbox',
          id: inputId,
          value: s.id,
          ...(s.available ? { checked: '' } : { disabled: '' }),
        }),
        h('label', { class: 'form-check-label', for: inputId }, s.label, s.available ? '' : h('span', { class: 'badge bg-secondary ms-2', text: '尚未開放' }))
      );
    })
  );
}

function renderCard(system) {
  const enabled = !system.disabled;
  return h(
    'div',
    { class: 'col-12 col-lg-6' },
    h(
      'div',
      { class: 'card shadow-sm border-0 h-100' },
      h(
        'div',
        { class: 'card-body' },
        h(
          'div',
          { class: 'd-flex justify-content-between align-items-start mb-2' },
          h('div', {}, h('h5', { class: 'mb-0', text: system.name }), h('code', { class: 'small', text: system.system })),
          h('span', { class: `badge ${enabled ? 'bg-success' : 'bg-secondary'}`, text: enabled ? '啟用中' : '已停用' })
        ),
        h('div', { class: 'mb-2' }, (system.scopes || []).map((s) => h('span', { class: 'badge bg-light text-dark border me-1', text: scopeLabel(s) }))),
        h('div', { class: 'text-muted small mb-3', text: `建立於 ${formatDate(system.createdAt)}` }),
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2' },
          h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: enabled ? '停用' : '啟用', onclick: (e) => toggleSystem(system, e.currentTarget) }),
          h('button', { type: 'button', class: 'btn btn-sm btn-outline-warning', text: '輪替金鑰', onclick: (e) => rotateKey(system, e.currentTarget) }),
          h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', text: '刪除', onclick: (e) => deleteSystem(system, e.currentTarget) })
        )
      )
    )
  );
}

function renderList(systems) {
  byId('system-loading').classList.add('d-none');
  byId('system-list').replaceChildren(...systems.map(renderCard));
  byId('system-empty').classList.toggle('d-none', systems.length > 0);
}

// ── 資料 ──

async function loadBot() {
  const res = await call('GET', '/team/members');
  if (res.ok && res.data && typeof res.data.botId === 'string') botId = res.data.botId;
  byId('system-bot-label').textContent = botId ? `目前管理專案（Bot ID: ${botId}）` : '目前管理專案';
  byId('system-usage').textContent = buildCurlExample(apiBase, botId);
}

async function loadSystems() {
  const res = await call('GET', '/bridge/v1/systems');
  if (res.status === 403) {
    byId('system-loading').classList.add('d-none');
    byId('btn-register-system').classList.add('d-none');
    showNotice(describeError(403, res.data));
    return;
  }
  if (!res.ok) {
    byId('system-loading').classList.add('d-none');
    showNotice(describeError(res.status, res.data));
    return;
  }
  renderList(Array.isArray(res.data?.systems) ? res.data.systems : []);
}

// ── 已連結的產品（LM-2A）──
// 與上面的「系統」互相獨立：這一段任何地方失敗都只影響這個區塊，不會丟到 pageInit 外面。

function renderLinkCard(link) {
  const active = link.status === 'active';
  const body = h('div', { class: 'card-body' });
  const root = h('div', { class: 'col-12 col-lg-6' }, h('div', { class: 'card shadow-sm border-0 h-100' }, body));
  const canEditFallback = active && link.productKey && link.scopes.includes('events:receive');
  body.append(
    h(
      'div',
      { class: 'd-flex justify-content-between align-items-start gap-2 mb-2' },
      h('h5', { class: 'mb-0 text-break', style: 'min-width:0', text: link.productName }),
      h('span', { class: `badge flex-shrink-0 ${active ? 'bg-success' : 'bg-secondary'}`, text: active ? '使用中' : '已撤銷' })
    ),
    h('div', { class: 'mb-2' }, link.scopes.map((s) => h('span', { class: 'badge bg-light text-dark border me-1 mb-1', text: scopeShortLabel(s) }))),
    h('div', { class: 'text-muted small', text: `連結時間：${formatIsoTime(link.createdAt)}` }),
    active ? null : h('div', { class: 'text-muted small', text: `撤銷時間：${formatIsoTime(link.revokedAt)}` }),
    active
      ? h(
          'div',
          { class: 'd-flex flex-wrap gap-2 mt-3' },
          h('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', text: '撤銷', onclick: (e) => revokeLink(link, e.currentTarget) }),
          canEditFallback
            ? h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: '備用訊息', onclick: () => toggleFallbackEditor(link, body) })
            : null
        )
      : null
  );
  return root;
}

// ── 事件備用訊息（LM-4B）──
// 產品無法即時回應（逾時、錯誤、回應不合規定）時，LM 改送這裡設定的訊息；沒設定的動作送「目前無法查詢，請稍後再試」。
// 只列出這個產品的 product_key 下已設定的動作；內容的最終驗證在伺服器端。

async function loadFallbacks(link) {
  const res = await call('GET', `/bridge/v1/admin/event-fallbacks?product_key=${encodeURIComponent(link.productKey)}`, null, { 'X-Bot-Id': botId });
  if (!res.ok) return { error: describeFallbackError(res.status, res.data) };
  const rows = res.data && Array.isArray(res.data.fallbacks) ? res.data.fallbacks : [];
  return { rows: rows.filter((r) => r && typeof r.action === 'string' && r.content && typeof r.content === 'object') };
}

function toggleFallbackEditor(link, container) {
  const existing = container.querySelector('[data-fallback-editor]');
  if (existing) {
    existing.remove();
    return;
  }
  const editor = h('div', { class: 'border-top mt-3 pt-3', 'data-fallback-editor': '1' });
  container.append(editor);
  renderFallbackEditor(link, editor);
}

async function renderFallbackEditor(link, editor) {
  editor.replaceChildren(h('div', { class: 'text-muted small', text: '載入中…' }));
  const loaded = await loadFallbacks(link);
  const field = (label, input) => h('div', { class: 'mb-2' }, h('label', { class: 'form-label small mb-1', text: label }), input);
  const action = h('input', { class: 'form-control form-control-sm', placeholder: 'plans', maxlength: '32', autocomplete: 'off' });
  const title = h('input', { class: 'form-control form-control-sm', maxlength: '40' });
  const text = h('textarea', { class: 'form-control form-control-sm', rows: '3', maxlength: '300' });
  const label = h('input', { class: 'form-control form-control-sm', maxlength: '20', placeholder: '（選填）按鈕文字' });
  const url = h('input', { class: 'form-control form-control-sm', placeholder: '（選填）https://… 必須在產品登記的網域內', autocomplete: 'off' });
  const fill = (row) => {
    action.value = row.action;
    title.value = row.content.title || '';
    text.value = row.content.body || '';
    label.value = (row.content.action && row.content.action.label) || '';
    url.value = (row.content.action && row.content.action.url) || '';
  };
  const list = loaded.error
    ? h('div', { class: 'text-danger small', text: loaded.error })
    : h(
        'div',
        { class: 'mb-3' },
        loaded.rows.length === 0 ? h('div', { class: 'text-muted small', text: '尚未設定。沒設定的動作會送「目前無法查詢，請稍後再試」。' }) : null,
        loaded.rows.map((row) =>
          h(
            'div',
            { class: 'd-flex justify-content-between align-items-center gap-2 small mb-1' },
            h('span', { class: 'text-break', style: 'min-width:0', text: `${row.action}：${row.content.title || ''}` }),
            h(
              'span',
              { class: 'flex-shrink-0' },
              h('button', { type: 'button', class: 'btn btn-sm btn-link', text: '編輯', onclick: () => fill(row) }),
              h('button', {
                type: 'button', class: 'btn btn-sm btn-link text-danger', text: '刪除',
                onclick: async () => {
                  const res = await call('DELETE', `/bridge/v1/admin/event-fallbacks?product_key=${encodeURIComponent(link.productKey)}&action=${encodeURIComponent(row.action)}`, null, { 'X-Bot-Id': botId });
                  if (!res.ok) return toast.error(describeFallbackError(res.status, res.data));
                  toast.success('已刪除');
                  renderFallbackEditor(link, editor);
                },
              })
            )
          )
        )
      );
  editor.replaceChildren(
    h('div', { class: 'fw-semibold small mb-2', text: '無法回應時的備用訊息' }),
    list,
    field('動作名稱（對應 Rich Menu 的 px:' + link.productKey + ':動作）', action),
    field('標題', title),
    field('內文', text),
    field('按鈕文字', label),
    field('按鈕網址', url),
    h('button', {
      type: 'button', class: 'btn btn-sm btn-primary', text: '儲存',
      onclick: async (e) => {
        const built = buildFallbackPayload({ productKey: link.productKey, action: action.value, title: title.value, body: text.value, label: label.value, url: url.value });
        if (built.error) return toast.error(built.error);
        e.currentTarget.disabled = true;
        const res = await call('PUT', '/bridge/v1/admin/event-fallbacks', built.payload, { 'X-Bot-Id': botId });
        e.currentTarget.disabled = false;
        if (!res.ok) return toast.error(describeFallbackError(res.status, res.data));
        toast.success('已儲存');
        renderFallbackEditor(link, editor);
      },
    })
  );
}

function showLinkNotice(message) {
  const el = byId('link-notice');
  el.textContent = message || '';
  el.classList.toggle('d-none', !message);
}

async function loadLinks() {
  byId('link-loading').classList.remove('d-none');
  byId('link-empty').classList.add('d-none');
  showLinkNotice('');
  try {
    if (!botId) {
      byId('link-list').replaceChildren();
      showLinkNotice('無法確認目前的專案，暫時無法顯示已連結的產品。');
      return;
    }
    const res = await call('GET', '/bridge/v1/admin/links', null, { 'X-Bot-Id': botId });
    if (!res.ok) {
      byId('link-list').replaceChildren();
      // Bridge 未啟用時（404 沒有 body）或其他失敗：只在這個區塊提示
      showLinkNotice(describeLinkError(res.status, res.data, 'admin'));
      return;
    }
    const links = normalizeLinks(res.data);
    byId('link-list').replaceChildren(...links.map(renderLinkCard));
    byId('link-empty').classList.toggle('d-none', links.length > 0);
  } catch {
    showLinkNotice('發生未知錯誤');
  } finally {
    byId('link-loading').classList.add('d-none');
  }
}

async function revokeLink(link, button) {
  // showConfirm 會把標題與訊息逸出，產品名稱（外部輸入）放進去是安全的
  const confirmed = await showConfirm({
    title: '撤銷連結',
    message: `撤銷「${link.productName.slice(0, 40)}」後，該產品立即無法再使用，需重新授權才能恢復。\n確定要撤銷嗎？`,
    confirmText: '撤銷',
    type: 'danger',
  });
  if (!confirmed) return;

  await withBusy(button, async () => {
    const res = await call('DELETE', `/bridge/v1/admin/links/${encodeURIComponent(link.linkId)}`, null, { 'X-Bot-Id': botId });
    if (!res.ok) return toast.error(describeLinkError(res.status, res.data, 'admin'));
    toast.success('已撤銷，該產品立即無法再使用');
    await loadLinks();
  });
}

// ── 動作 ──

/** 顯示金鑰。金鑰只放進唯讀欄位，不存任何變數；對話框關閉時清掉。 */
function showKey(system, apiKey) {
  byId('system-key-system').textContent = system;
  byId('system-key-value').value = apiKey;
  modal('systemKeyModal').show();
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(okMessage);
  } catch {
    toast.warning('無法自動複製，請長按選取後手動複製');
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const errorBox = byId('system-form-error');
  errorBox.classList.add('d-none');

  const checked = [...byId('system-scopes').querySelectorAll('input:checked')].map((el) => el.value);
  const result = buildCreatePayload({
    system: byId('system-id-input').value,
    name: byId('system-name-input').value,
    scopes: checked,
  });
  if (!result.ok) {
    errorBox.textContent = result.error;
    errorBox.classList.remove('d-none');
    return;
  }

  await withBusy(byId('btn-submit-system'), async () => {
    const res = await call('POST', '/bridge/v1/systems', result.payload);
    if (!res.ok) {
      errorBox.textContent = describeError(res.status, res.data);
      errorBox.classList.remove('d-none');
      return;
    }
    const { system, apiKey } = res.data;
    modal('registerSystemModal').hide();
    byId('system-form').reset();
    showKey(system, apiKey);
    await loadSystems();
  });
}

async function toggleSystem(system, button) {
  await withBusy(button, async () => {
    const res = await call('PATCH', `/bridge/v1/systems/${encodeURIComponent(system.system)}`, { disabled: !system.disabled });
    if (!res.ok) return toast.error(describeError(res.status, res.data));
    toast.success(system.disabled ? '已啟用' : '已停用，這個系統的金鑰立即無法使用');
    await loadSystems();
  });
}

async function rotateKey(system, button) {
  const confirmed = await showConfirm({
    title: '輪替金鑰',
    message: `${safeName(system.system)}目前的金鑰會立即失效，仍在使用舊金鑰的程式會馬上無法推播。\n確定要輪替嗎？`,
    confirmText: '輪替',
    type: 'warning',
  });
  if (!confirmed) return;

  await withBusy(button, async () => {
    const res = await call('POST', `/bridge/v1/systems/${encodeURIComponent(system.system)}/keys/rotate`, {});
    if (!res.ok) return toast.error(describeError(res.status, res.data));
    showKey(res.data.system, res.data.apiKey);
  });
}

async function deleteSystem(system, button) {
  const confirmed = await showConfirm({
    title: '刪除系統',
    message: `刪除${safeName(system.system)}後，它的金鑰會立即失效，而且無法復原。\n確定要刪除嗎？`,
    confirmText: '刪除',
    type: 'danger',
  });
  if (!confirmed) return;

  await withBusy(button, async () => {
    const res = await call('DELETE', `/bridge/v1/systems/${encodeURIComponent(system.system)}`, null);
    if (!res.ok) return toast.error(describeError(res.status, res.data));
    toast.success('已刪除');
    await loadSystems();
  });
}

// ── 進入點 ──

export async function pageInit() {
  renderScopes();

  byId('btn-register-system').addEventListener('click', () => {
    byId('system-form').reset();
    byId('system-form-error').classList.add('d-none');
    modal('registerSystemModal').show();
  });
  byId('system-form').addEventListener('submit', submitRegister);

  byId('btn-copy-key').addEventListener('click', () => copyText(byId('system-key-value').value, '已複製金鑰'));
  byId('btn-copy-usage').addEventListener('click', () => copyText(byId('system-usage').textContent, '已複製範例'));

  // 金鑰對話框關閉就清掉欄位，金鑰不會殘留在畫面或 DOM 裡
  byId('systemKeyModal').addEventListener('hidden.bs.modal', () => {
    const input = byId('system-key-value');
    if (input) input.value = '';
  });

  await loadBot();
  await loadSystems();
  // 連結區塊自成一體：不 await —— 它慢或失敗都不該拖住全頁的載入遮罩與上面的系統列表（loadLinks 自己吞掉所有錯誤）
  loadLinks();
}
