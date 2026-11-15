/**
 * 系統整合管理頁
 *
 * 讓 bot 的管理員（owner）註冊、停用、輪替、刪除「系統」（接到這個 LINE 官方帳號上的
 * 垂直後端），並取得 service key。對應後端 worker_src/handler/systems.js。
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

const byId = (id) => document.getElementById(id);

function formatDate(ts) {
  if (typeof ts !== 'number') return '—';
  return new Date(ts).toLocaleString('zh-TW', { hour12: false });
}

function scopeLabel(id) {
  const found = SCOPES.find((s) => s.id === id);
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
  const res = await call('GET', '/api/v1/systems');
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
    const res = await call('POST', '/api/v1/systems', result.payload);
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
    const res = await call('PATCH', `/api/v1/systems/${encodeURIComponent(system.system)}`, { disabled: !system.disabled });
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
    const res = await call('POST', `/api/v1/systems/${encodeURIComponent(system.system)}/keys/rotate`, {});
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
    const res = await call('DELETE', `/api/v1/systems/${encodeURIComponent(system.system)}`, null);
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
}
