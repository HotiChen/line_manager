# Project Issues Tracker

**審查日期**: 2026-06-07  
**審查範圍**: 全 codebase（frontend + worker_src）  
**狀態凡例**: 🔴 待處理 | 🟡 進行中 | ✅ 已完成

---

## 目錄

1. [資安問題（Security）](#security)
2. [Bug](#bugs)
3. [待開發功能](#features)

---

## Security

### SEC-001 — [CRITICAL] 邀請接受 API 未驗證 userId 身份

**狀態**: 🔴 待處理  
**檔案**: [`worker_src/handler/team.js:204`](worker_src/handler/team.js)  
**嚴重度**: Critical — 可偽造任意用戶身份加入團隊

**問題描述**  
`handleAcceptInvite` 從 request body 直接讀取 `userId`，完全沒有透過 LIFF token 驗證。任何拿到合法 invite token 的人都能傳入任意 userId，把任何帳號加入團隊。

```js
// 現況 — 危險
export async function handleAcceptInvite(request, env) {
    const { token, userId, displayName, pictureUrl } = await request.json();
    // userId 沒有驗證，攻擊者可偽造任意 LINE userId
```

**修法**  
邀請接受流程應改為：
1. 前端呼叫時帶 `Authorization: Bearer <LIFF token>`
2. Worker 透過 LINE API 驗證 token 取得真實 userId
3. 忽略 body 裡的 userId 欄位

---

### SEC-002 — [CRITICAL] LIFF 模式下 X-User-Id Header 可繞過認證

**狀態**: 🔴 待處理  
**檔案**: [`worker_src/middleware/auth.js:71`](worker_src/middleware/auth.js)  
**嚴重度**: Critical — 任何人可偽裝成任意用戶呼叫所有 API

**問題描述**  
生產模式 (`AUTH_MODE=liff`) 下，仍接受 `X-User-Id` header 作為回退認證，僅印 warning 但直接通過：

```js
if (authMode === "liff") {
    const userId = request.headers.get("X-User-Id");
    if (userId) {
        console.warn(...); // 只是警告，仍然通過！
        return { authenticated: true, userId }; // ← Auth Bypass
    }
}
```

**修法**  
生產環境移除 X-User-Id 回退分支，必須要有合法 LIFF token：

```js
if (authMode === "liff") {
    return { authenticated: false, error: "Authorization header required" };
}
```

---

### SEC-003 — [HIGH] Webhook 簽章驗證可被跳過

**狀態**: ✅ 已完成 (`worker_src/handler/webhook.js`)  
**檔案**: [`worker_src/handler/webhook.js:37`](worker_src/handler/webhook.js)  
**嚴重度**: High — 缺少 secret 時任何人可偽造 LINE webhook

**問題描述**  
`LINE_CHANNEL_SECRET` 未設定時，簽章驗證完全跳過，不回傳錯誤：

```js
if (channelSecret) {
    const isValid = await verifySignature(request, bodyText, channelSecret);
    if (!isValid) return new Response('Unauthorized', { status: 401 });
} else {
    logger.warn('CONFIG', '缺少 LINE_CHANNEL_SECRET，跳過簽章驗證');
    // ← 照常繼續處理，沒有任何阻擋
}
```

**修法**  
`channelSecret` 不存在時應直接拒絕請求：

```js
if (!channelSecret) {
    logger.error('CONFIG', '未設定 LINE_CHANNEL_SECRET，拒絕所有 webhook 請求');
    return new Response('Service Misconfigured', { status: 500 });
}
const isValid = await verifySignature(request, bodyText, channelSecret);
if (!isValid) return new Response('Unauthorized', { status: 401 });
```

---

### SEC-004 — [HIGH] 67 處 innerHTML 直接賦值（未過 DOMPurify）

**狀態**: 🔴 待處理（TODO.md P0 未完成）  
**偵測指令**: `grep -rn "\.innerHTML\s*=" js/ | grep -v "setInnerHTML"`  
**嚴重度**: High — 若有任一處使用到用戶輸入，即可 XSS

**問題描述**  
專案已有 `setInnerHTML()` wrapper（透過 DOMPurify 過濾），但仍有 67 處直接使用 `element.innerHTML = ...` 繞過保護。

**修法**  
優先處理有用戶輸入的高風險區域：
1. `js/richmenu.js` 附近的 677-703 行（TODO.md 已標記）
2. `js/flex_builder.js`
3. `js/member_builder.js`

批次替換規則：
- 純文字 → 改用 `textContent`
- 含 HTML 但非用戶輸入 → 保留 `innerHTML`（已安全）
- 含用戶輸入的 HTML → 改用 `setInnerHTML(el, content)`

---

### SEC-005 — [MEDIUM] CORS 全開 `Access-Control-Allow-Origin: *`

**狀態**: 🔴 待處理  
**檔案**: [`worker_src/index.js:42`](worker_src/index.js), [`worker_src/lib/utils.js:25`](worker_src/lib/utils.js)  
**嚴重度**: Medium

**問題描述**  
所有 API 回應（包含寫入操作）都帶 wildcard CORS，允許任意第三方網站呼叫你的 API。

**修法**  
限定 origin 白名單：

```js
const ALLOWED_ORIGINS = [
    "https://your-production-domain.workers.dev",
    "https://liff.line.me",
];
const origin = request.headers.get("Origin");
const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

// 回應時使用
"Access-Control-Allow-Origin": allowOrigin,
```

---

### SEC-006 — [MEDIUM] Rate Limiter 在多 Isolate 環境無效

**狀態**: 🔴 待處理  
**檔案**: [`worker_src/middleware/rate_limiter.js`](worker_src/middleware/rate_limiter.js)  
**嚴重度**: Medium — 實際限制遠低於設定值

**問題描述**  
Rate limiter 使用 in-memory `Map`，每個 Cloudflare Worker isolate 獨立計數。同一 userId 的請求分散到多個 isolate 時，每個 isolate 的計數各自從 0 開始，實際有效限制 = 設定值 / isolate 數量。

**修法**  
改用 Cloudflare Durable Objects 或 KV 做分散式計數：

```js
// 使用 KV 做簡易分散式 rate limit
const kvKey = `rl_${userId}_${Math.floor(Date.now() / (windowSec * 1000))}`;
const count = parseInt(await env.KV_LINE_STORAGE.get(kvKey) || "0") + 1;
await env.KV_LINE_STORAGE.put(kvKey, String(count), { expirationTtl: windowSec * 2 });
if (count > limit) { /* 拒絕 */ }
```

---

### SEC-007 — [LOW] 敏感設定值暴露在版控

**狀態**: 🔴 待處理  
**檔案**: [`wrangler.jsonc:4`](wrangler.jsonc)  
**嚴重度**: Low

**問題描述**  
LIFF_ID (`1653928585-8Kkz0jnz`) 和 KV namespace ID 硬編碼在版控中。

**修法**  
- LIFF_ID 透過 `wrangler secret put LIFF_ID` 設定（已有類似 MIGRATION_SECRET 的做法）
- 或至少加入 `.gitignore` 的 secrets 範本說明

---

## Bugs

### BUG-001 — 登出後 localStorage 未清除（userId 殘留）

**狀態**: ✅ 已完成 (`helper/state.js` + `js/main.js`)  
**檔案**: [`js/main.js:108`](js/main.js) + [`helper/state.js:14`](helper/state.js)

**問題描述**  
登出時呼叫 `setUserId(null)`，但 `setUserId` 對 null/非字串 early return，localStorage 從未清除。重整頁面後舊 userId 仍在，實際上沒有真正登出。

```js
// helper/state.js
export function setUserId(id) {
    if (!id || typeof id !== 'string') {
        console.warn('...invalid...');
        return; // ← 沒有清除 localStorage
    }
    localStorage.setItem('linebot_userId', id);
}

// js/main.js 登出時
setUserId(null); // ← null 觸發 early return，localStorage 不動
```

**修法**  
在登出流程明確清除 localStorage：

```js
// 登出 handler 裡加這幾行
localStorage.removeItem('linebot_userId');
localStorage.removeItem('flow_designer_bot');
state.userId = null;
```

---

### BUG-002 — `initializeBotSelector` 重複呼叫堆疊 event listener

**狀態**: ✅ 已完成 (`js/main.js` — AbortController)  
**檔案**: [`js/main.js:69`](js/main.js)

**問題描述**  
每次切換頁面呼叫 `initializeBotSelector` 時，都在 `#bot-select-global` 上新增一個 `change` event listener，沒有先移除舊的。切換 10 次頁面後，change 事件會觸發 10 次。

**修法**  
使用 `{ once: false }` + 先移除舊的，或用 clone：

```js
// 方法一：用 AbortController 移除
const controller = new AbortController();
botSelect.addEventListener('change', handler, { signal: controller.signal });
// 下次呼叫前 controller.abort() 清除

// 方法二：換用 clone 清除所有 listener
const newSelect = botSelect.cloneNode(true);
botSelect.parentNode.replaceChild(newSelect, botSelect);
```

---

### BUG-003 — `loadPage` 不檢查 HTTP status

**狀態**: ✅ 已完成 (`js/main.js`)  
**檔案**: [`js/main.js:38`](js/main.js)

**問題描述**  
fetch HTML 後直接注入，不管 response 是否成功。404 或 500 的錯誤 HTML 會被當作頁面內容顯示。

```js
const res = await fetch(`./pages/${pageName}.html?cb=${Date.now()}`);
setInnerHTML(content, await res.text()); // ← 沒有 if (!res.ok) throw ...
```

**修法**  

```js
const res = await fetch(`./pages/${pageName}.html?cb=${Date.now()}`);
if (!res.ok) throw new Error(`頁面載入失敗 (${res.status}): ${pageName}`);
setInnerHTML(content, await res.text());
```

---

### BUG-004 — Flow 列表 index 累積孤兒 ID

**狀態**: ✅ 已完成 (`worker_src/handler/flow.js`)  
**檔案**: [`worker_src/handler/flow.js`](worker_src/handler/flow.js)

**問題描述**  
刪除 flow 時若 KV 操作部分失敗（網路中斷等），list index 裡的 flowId 會殘留。長期下來 `handleListFlows` 每次都要 fetch N 個找不到的 KV key，影響效能與回應速度。

**修法**  
`handleDeleteFlow` 刪除後同步更新 list index；`handleListFlows` filter 掉 null 後，把清理後的 list 寫回 KV：

```js
// handleListFlows 末尾加
const validIds = flows.filter(Boolean).map(f => f.id);
if (validIds.length !== ids.length) {
    await env.KV_LINE_STORAGE.put(listKey(userId, botId), JSON.stringify(validIds));
}
```

---

## Features

### FEAT-001 — Flow 版本歷史 UI

**狀態**: 🔴 待開發  
**優先度**: 高  
**背景**: Backend 已有版本儲存邏輯（KV key `flow_version_*`，TTL 30 天），但完全沒有前端介面。

**期望功能**  
- 在 Flow Designer 右上角加「版本歷史」按鈕
- 顯示過去 30 天的版本列表（時間 + 節點數）
- 點擊可預覽或還原

---

### FEAT-002 — Webhook 事件 Log

**狀態**: 🔴 待開發  
**優先度**: 高  
**背景**: 現在用戶完全看不到 LINE 發來了哪些 webhook、哪個 flow 被觸發、回覆了什麼。Debug 時需要完全依賴 Cloudflare Dashboard。

**期望功能**  
- 在 Dashboard 加「事件記錄」頁籤
- 顯示最近 N 筆 webhook 事件（類型、觸發時間、處理結果）
- 可以展開看詳細 payload

---

### FEAT-003 — Flow 執行引擎

**狀態**: 🔴 待確認  
**優先度**: 高  
**背景**: Flow Designer 的視覺化設計非常完整，但 webhook handler 目前路由到 `EventHandler`（`lib/event_handler.js`），需確認是否有實際讀取 flow 定義執行的邏輯。若無，Flow Designer 目前只是設計工具，沒有和 bot 行為連動。

**期望功能**  
- Webhook 收到事件 → 查找對應 bot 的 flow 定義 → 按 flow 節點執行

---

### FEAT-004 — 排程廣播訊息

**狀態**: 🔴 待開發  
**優先度**: 中  
**背景**: Message Push 頁面只能立即發送，無法設定未來時間點發送。

**期望功能**  
- 廣播時可選「立即」或「排程」
- 排程使用 Cloudflare Queues 或 Cron Triggers 實作

---

### FEAT-005 — Flow 匯出 / 匯入

**狀態**: 🔴 待開發  
**優先度**: 中  

**期望功能**  
- Flow Designer 加「匯出 JSON」按鈕，下載完整 flow 定義
- 支援從 JSON 檔案匯入 flow（覆蓋或新建）
- 方便帳號間複製、版本備份

---

### FEAT-006 — 操作稽核日誌

**狀態**: 🔴 待開發  
**優先度**: 中  

**期望功能**  
- 記錄關鍵操作：成員新增/移除、Token 變更、Flow 刪除、廣播發送
- 顯示操作者、時間、詳情
- 僅 owner 可查看

---

### FEAT-007 — 推播訊息成效追蹤

**狀態**: 🔴 待開發  
**優先度**: 低  

**期望功能**  
- 廣播後顯示送達人數
- 搭配 LINE Insight API 顯示開啟率（若 API 支援）

---

### FEAT-008 — A/B 測試訊息

**狀態**: 🔴 待開發  
**優先度**: 低  

**期望功能**  
- 同一個關鍵字/flow 節點可設定多個回覆版本
- 按比例隨機分流
- 比較各版本點擊/互動率

---

## 優先執行順序

```
立即處理（資安）:
  SEC-002 → SEC-001 → SEC-003 → SEC-004

這週內（Bug）:
  BUG-001 → BUG-003 → BUG-002 → BUG-004

下一個 Sprint（架構）:
  SEC-005 → SEC-006

功能開發（依業務優先度排）:
  FEAT-003（確認執行引擎）→ FEAT-002 → FEAT-001 → FEAT-005 → FEAT-004 → FEAT-006
```
