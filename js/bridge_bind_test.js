/**
 * Bridge 綁定測試頁（LM-3A-2）（暫時，測完即刪）。
 *
 * 同源呼叫 /bridge/v1，不需要 CORS。
 * 安全：管理密鑰只在送出瞬間讀取並立即清空輸入框、絕不儲存；
 * 產品密鑰、連結金鑰、授權碼只放 sessionStorage，且永遠不顯示在畫面上。
 */
const KEY = "bridge_bind_test_state";
const SECRET_FIELDS = new Set(["product_secret", "service_key", "bind_code"]);
const byId = (id) => document.getElementById(id);
const base = `${location.origin}${location.pathname.replace(/\/pages\/[^/]*$/, "")}/bridge/v1`;
const callbackUrl = `${location.origin}${location.pathname}`;

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
let st = load();
function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(st));
  } catch {
    // 沒有 storage 時，授權跳轉後會遺失狀態，頁面仍可操作其他步驟
  }
  renderState();
}

function renderState() {
  const mark = (v) => (v ? "✔" : "－");
  byId("state-line").textContent =
    `產品 ${mark(st.productId)}　授權碼 ${mark(st.code)}　連結 ${mark(st.linkId)}　金鑰 ${mark(st.linkKey)}　ref ${mark(st.ref)}`;
}

function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELDS.has(k) ? "（已收下，不顯示）" : mask(v);
    return out;
  }
  return value;
}

function show(title, res, data) {
  const out = byId("out");
  const line = document.createElement("div");
  const head = document.createElement("span");
  head.className = res && res.ok ? "ok" : "bad";
  head.textContent = `${title} → ${res ? res.status : "網路錯誤"}`;
  line.append(head, document.createElement("br"), document.createTextNode(data == null ? "" : JSON.stringify(mask(data), null, 1)));
  if (out.firstChild && out.textContent === "（尚無）") out.replaceChildren();
  out.prepend(document.createElement("hr"));
  out.prepend(line);
}

async function call(title, method, path, { headers = {}, body } = {}) {
  let res = null;
  let data = null;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } catch {
    // 網路錯誤：res 維持 null
  }
  show(title, res, data);
  return { res, data };
}

const bearer = (k) => ({ Authorization: `Bearer ${k}` });
const need = (cond, msg) => {
  if (!cond) show(msg, null, null);
  return Boolean(cond);
};

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 動作 ──

byId("b-health").onclick = () => call("GET /health", "GET", "/health");

byId("b-register").onclick = async () => {
  const input = byId("admin-secret");
  const secret = input.value.trim();
  input.value = ""; // 立即清空，不留在畫面
  if (!need(secret, "請先輸入 BRIDGE_ADMIN_SECRET")) return;
  const { res, data } = await call("登記產品", "POST", "/admin/products", {
    headers: bearer(secret),
    body: {
      name: "測試產品",
      redirect_uris: [callbackUrl],
      url_domains: [location.hostname],
      scopes: ["link:manage", "contacts:bind", "messages:send"],
    },
  });
  if (res && res.status === 201 && data) {
    st.productId = data.product_id;
    st.productSecret = data.product_secret;
    save();
  }
};

function authorizeUrl(redirect) {
  const q = new URLSearchParams({ product_id: st.productId, state: st.state, redirect_uri: redirect });
  return `${base}/link/authorize?${q}`;
}

byId("b-authorize").onclick = () => {
  if (!need(st.productId, "請先登記產品")) return;
  st.state = randomHex(8);
  save();
  location.assign(authorizeUrl(callbackUrl));
};

byId("b-authorize-evil").onclick = () => {
  if (!need(st.productId, "請先登記產品")) return;
  st.state = randomHex(8);
  save();
  location.assign(authorizeUrl("https://evil.example.com/callback")); // 預期：顯示錯誤，不導向
};

async function exchange(title, code) {
  return call(title, "POST", "/links/token", {
    headers: bearer(st.productSecret),
    body: { code, redirect_uri: callbackUrl },
  });
}

byId("b-exchange").onclick = async () => {
  if (!need(st.productSecret && st.code, "還沒有授權碼，請先完成步驟 3")) return;
  const code = st.code;
  const { res, data } = await exchange("換碼", code);
  if (res && res.status === 200 && data) {
    st.oldKey = st.linkKey || "";
    st.linkId = data.link_id;
    st.linkKey = data.service_key;
    st.usedCode = code;
    st.code = "";
    save();
  }
};

byId("b-replay").onclick = () => {
  if (!need(st.productSecret && st.usedCode, "沒有已用過的授權碼")) return;
  return exchange("重放舊碼（預期 INVALID_CODE）", st.usedCode);
};

const linkPath = () => `/links/${encodeURIComponent(st.linkId)}`;

byId("b-get").onclick = () => {
  if (!need(st.linkKey, "還沒有連結金鑰")) return;
  return call("GET 連結", "GET", linkPath(), { headers: bearer(st.linkKey) });
};

byId("b-rotate").onclick = async () => {
  if (!need(st.linkKey, "還沒有連結金鑰")) return;
  const { res, data } = await call("輪替金鑰", "POST", `${linkPath()}/rotate-key`, { headers: bearer(st.linkKey) });
  if (res && res.status === 200 && data && data.service_key) {
    st.oldKey = st.linkKey;
    st.linkKey = data.service_key;
    save();
  }
};

byId("b-old").onclick = () => {
  if (!need(st.oldKey, "沒有舊金鑰（先輪替或重新授權一次）")) return;
  return call("舊金鑰 GET（預期失敗）", "GET", linkPath(), { headers: bearer(st.oldKey) });
};

byId("b-raw").onclick = () => {
  if (!need(st.linkKey, "還沒有連結金鑰")) return;
  return call("連結金鑰打 /raw/push（預期被拒）", "POST", "/raw/push", { headers: bearer(st.linkKey), body: {} });
};

byId("b-systems").onclick = () => {
  if (!need(st.linkKey, "還沒有連結金鑰")) return;
  return call("連結金鑰打 /systems（預期被拒）", "GET", "/systems", { headers: bearer(st.linkKey) });
};

byId("b-delete").onclick = () => {
  if (!need(st.linkKey, "還沒有連結金鑰")) return;
  return call("DELETE 連結（預期 204）", "DELETE", linkPath(), { headers: bearer(st.linkKey) });
};

byId("b-clear").onclick = () => {
  st = {};
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 忽略
  }
  renderState();
  show("已清除本分頁資料", { ok: true, status: 0 }, null);
};

// ── 7. 聯絡人綁定 ──

const contactPath = (ref) => `/contacts/${encodeURIComponent(ref)}`;

function showBindBox(data) {
  byId("bind-box").style.display = "block";
  byId("bind-code").textContent = data.bind_code; // 授權用的單次碼：只顯示在這個框，不寫進結果紀錄
  const url = typeof data.bind_url === "string" && data.bind_url.startsWith("https://line.me/") ? data.bind_url : null;
  const a = byId("bind-url");
  if (url) {
    a.href = url;
    a.textContent = url;
  } else {
    a.removeAttribute("href");
    a.textContent = "";
  }
  byId("bind-url-line").style.display = url ? "block" : "none";
  byId("bind-no-url").style.display = url ? "none" : "block";
  byId("bind-exp").textContent = data.expires_at || "";
}

byId("b-bind-token").onclick = async () => {
  if (!need(st.linkKey, "還沒有連結金鑰，請先完成步驟 2 到 4")) return;
  if (!st.ref) {
    st.ref = `test-${randomHex(6)}`; // 8 到 64 字、僅英數與 - _
    save();
  }
  const { res, data } = await call("要綁定碼", "POST", "/contacts/bind-tokens", {
    headers: bearer(st.linkKey),
    body: { external_contact_ref: st.ref },
  });
  if (res && res.status === 201 && data) showBindBox(data);
};

byId("b-bind-status").onclick = () => {
  if (!need(st.linkKey && st.ref, "還沒有綁定碼")) return;
  return call("綁定狀態（pending 代表碼還沒被使用，bound 代表成功）", "GET", contactPath(st.ref), { headers: bearer(st.linkKey) });
};

byId("b-bind-delete").onclick = () => {
  if (!need(st.linkKey && st.ref, "還沒有綁定碼")) return;
  return call("解除綁定（預期 204）", "DELETE", contactPath(st.ref), { headers: bearer(st.linkKey) });
};

byId("b-bind-bad").onclick = () => {
  if (!need(st.linkKey, "還沒有連結金鑰")) return;
  return call("別的 ref（預期 unbound）", "GET", contactPath(`other-${randomHex(6)}`), { headers: bearer(st.linkKey) });
};

// ── 從同意頁回來：收下授權碼，並立刻把它從網址列移除 ──

function takeCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return;
  const code = q.get("code");
  const state = q.get("state");
  history.replaceState(null, "", location.pathname);
  if (code && state && st.state && state === st.state) {
    st.code = code;
    st.state = "";
    save();
    show("授權成功，state 相符，已收下授權碼", { ok: true, status: 0 }, null);
  } else {
    show("回呼的 state 不符或帶有錯誤，已忽略", null, null);
  }
}

renderState();
takeCallback();
