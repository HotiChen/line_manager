# line_manager 平台架構（可擴張設計）

2026-11-10。這份只講架構，不含實作步驟。

目標：讓 line_manager 成為「任何行業都能接上的 LINE 平台層」——
攝影工作室、美髮、服飾、餐飲，接第 N 個垂直時是**註冊設定**，不是改程式。

---

## 一、唯一的架構不變量

> **line_manager 的程式碼不得出現任何行業詞彙。**
>
> 業務意義只能以**不透明字串**存在於資料中（tag 的值、postback 的 payload、
> 訊息內容），永遠不可成為程式的分支條件。

合法：

```js
await addTagsToEntity(env, botId, 'member', lineUserId, tags);   // tags 是呼叫端給的字串
reply(replyToken, messages);                                      // messages 是呼叫端組好的
```

違規（一旦出現，擴張就死了）：

```js
if (tag === '已交件') { … }           // 攝影業詞彙進了程式
if (event.kind === 'appointment') { … } // 美髮詞彙進了程式
PHOTO_STATUS_LABELS = { … }            // 行業對照表不該在這裡
```

這條規則決定了下面每一個設計。**違反它的 PR 應該被退回，而不是被討論。**

---

## 二、分層

```
┌─────────────────────────────────────────────────────────────┐
│  垂直領域後端（各自獨立，line_manager 不認識它們）              │
│  studio / salon / shop / …                                   │
│  擁有：預約、訂單、專案、庫存 —— 所有業務狀態與業務語意          │
└───────────────┬──────────────────────────────▲──────────────┘
                │ 呼叫 API                      │ 收 webhook
┌───────────────▼──────────────────────────────┴──────────────┐
│  line_manager ── 平台層                                      │
│                                                              │
│  ① 身分      lineUserId ↔ (system, externalId) 多對多         │
│  ② CRM       member profile、tag、tier（值都是不透明字串）      │
│  ③ 傳輸      push / reply / multicast + 額度會計              │
│  ④ 事件      LINE webhook 正規化 → 扇出給訂閱的系統            │
│  ⑤ 內容      Rich Menu、關鍵字、Flex、歡迎訊息（per-bot 設定）   │
│  ⑥ 租戶      bot 隔離、staff 角色、service key                 │
└───────────────┬──────────────────────────────▲──────────────┘
                │ Messaging API                 │ webhook + 簽章
┌───────────────▼──────────────────────────────┴──────────────┐
│  LINE 平台（每個 bot 一個官方帳號）                            │
└──────────────────────────────────────────────────────────────┘
```

**平台層只做「跟行業無關的事」。** 判斷標準：換成美髮還需不需要這個功能？
需要 → 平台層。不需要 → 垂直後端。

---

## 三、租戶模型

```
platform                        平台營運者（你）
└── tenant                      一個生意（攝影工作室 / 美髮沙龍 / 服飾店）
    └── bot          ★          一個 LINE 官方帳號 —— 隔離邊界
        ├── staff               後台操作者 + 角色
        ├── member              LINE 好友（CRM 主體）
        ├── system              接上來的垂直後端（可多個）
        └── content             Rich Menu / 關鍵字 / Flex / 歡迎訊息
```

### 為什麼 `bot` 是隔離邊界而不是 `tenant`

1. LINE 的 channel secret / access token 是 per 官方帳號
2. 訊息額度（輕用量 200 則/月）是 per 官方帳號計算
3. 一個官方帳號不能同時服務兩個品牌（好友看到的是同一個帳號）

所以**所有資料的命名空間都是 botId**。`tenant` 只用來做計費歸戶與
staff 跨 bot 授權，不參與資料隔離。

### 一個生意可以有多個 bot

主帳號 + VIP 帳號、或南北分店各一個。靠 tenant 歸在一起。

---

## 四、身分模型（擴張性的核心）

### 錨點是 lineUserId，綁定是多對多

同一個人可能同時是你的攝影客人和美髮客人：

```
lineUserId  U1234…
  ├── (studio, "picker_abc")     攝影系統裡的客人 id
  ├── (salon,  "cust_7781")      美髮系統裡的會員 id
  └── (shop,   "u_99201")        服飾系統裡的帳號 id
```

**關鍵：`system` 必須是 key 的一部分。** 少了它，兩個系統的
`customer_123` 會寫進同一個 key。

### 綁定流程（行業無關）

```
垂直後端                line_manager                 客人
   │                         │                        │
   │ POST /link/tokens       │                        │
   │ {system, externalId}    │                        │
   ├────────────────────────►│                        │
   │                         │                        │
   │◄────────────────────────┤                        │
   │ {linkToken, liffUrl}    │                        │
   │                         │                        │
   │  （把 liffUrl 放進你本來就會傳給客人的訊息）          │
   │─────────────────────────────────────────────────►│
   │                         │                        │
   │                         │◄───────────────────────┤ 在 LINE 內點開
   │                         │   LIFF 取得 lineUserId  │
   │                         │   （他已登入 LINE，零摩擦）│
   │                         │                        │
   │◄────────────────────────┤                        │
   │ webhook: member.linked  │                        │
   │ {system, externalId,    │                        │
   │  lineUserId}            │                        │
```

這個流程對任何行業都一樣 —— 平台層只知道「某個系統的某個 id 綁到某個
lineUserId」，不知道那個 id 是客人、會員還是訂單。

**要推播就必須是好友。** 綁定頁要負責詢問加好友，否則會累積一堆
拿得到 userId 但推不出去的綁定。這是平台層的責任，不是垂直後端的。

---

## 五、認證模型：三種主體

| 主體 | 憑證 | 解析成 | 用在 |
|---|---|---|---|
| **人**（staff） | `Authorization: Bearer <LIFF token>` | botId + role | 後台頁面 |
| **系統**（垂直後端） | `Authorization: Bearer <service key>` + `X-Bot-Id` | botId + system + scopes | 伺服器對伺服器 |
| **LINE 平台** | `x-line-signature` HMAC | botId | 進來的 webhook |

三者走同一個中間件出口，都回 `{ botId, subject, scopes }`，下游 handler
只看這個結果，不管憑證長什麼樣。

### service key 設計

```
service_key_${sha256(key)} → {
  botId, system, scopes: [...], webhookUrl, events: [...],
  createdAt, lastUsedAt, revokedAt
}
```

- **只存雜湊**，不存原文
- 一把 key 綁一個 (botId, system)
- scope 限制能呼叫哪些端點（`messages:push`、`members:read`、`tags:write`…）
- 可撤銷，撤銷立即生效
- 發 key 必須由「人」主體操作 —— key 不能用來發 key

---

## 六、KV 命名空間

```
# ── 租戶與 bot ──
tenant_${tenantId}                      { name, bots[], plan }
bot_${botId}                            { tenantId, name, channelId, createdAt }
bot_staff_${botId}                      [{ userId, role }]
user_bots_${userId}                     { bots[], currentBotId }

# ── CRM（值都是不透明字串）──
member_${botId}_${lineUserId}           { displayName, pictureUrl, tags[], tier, joinedAt, lastSeenAt }
member_index_${botId}                   [lineUserId, …]            分頁 cursor
tag_members_${botId}_${tag}             [lineUserId, …]            反向索引

# ── 身分綁定 ──
link_token_${token}                     { botId, system, externalId, expiresAt, usedAt }
member_external_${botId}_${system}_${externalId}  → lineUserId     ★ system 必須在 key 裡
member_links_${botId}_${lineUserId}     [{ system, externalId, boundAt }]

# ── 外部系統註冊 ──
system_${botId}_${system}               { name, webhookUrl, events[], scopes[], disabledAt }
service_key_${keyHash}                  { botId, system, scopes[], revokedAt }

# ── 內容（per-bot，行業無關）──
keyword_${botId}_*    richmenu_${botId}_*    flex_${botId}_*
welcome_${botId}      quickreply_${botId}_*

# ── 額度會計 ──
quota_${botId}_${YYYYMM}                { pushed, free, plan, updatedAt }

# ── LINE 憑證 ──
（access token 不以明文存 KV：見第十節）
```

**命名規則**：`<domain>_${botId}[_${qualifier}]`。botId 永遠在第一個變數位置，
因為它是隔離邊界。現在的 `<domain>_${userId}` 是舊模型，要收斂掉。

---

## 七、API 介面（全部行業無關）

版本化在 `/api/v1/` 之下，與現有的前端端點分開。

### 傳輸

```
POST /api/v1/messages/reply       { replyToken, messages[] }        免費路徑
POST /api/v1/messages/push        { to, messages[] }                → { quotaConsumed, remaining }
POST /api/v1/messages/multicast   { to[], messages[] }              ≤ 500
```

`messages[]` 是**呼叫端組好的 LINE message object**。平台層不產生內容、
不套模板、不知道內容的意思 —— 這是不變量的直接結果。

回應**必須回報額度**，否則垂直後端無法做成本控制。

### CRM

```
GET    /api/v1/members/{lineUserId}
GET    /api/v1/members?tag=&tier=&cursor=&limit=
POST   /api/v1/members/{lineUserId}/tags        { add[], remove[] }
GET    /api/v1/members/by-external/{system}/{externalId}
```

tag 的值是任意字串。平台層只做集合運算與索引維護。

### 身分綁定

```
POST   /api/v1/link/tokens      { system, externalId, ttlSeconds }  → { linkToken, liffUrl }
GET    /api/v1/link/{linkToken}                                     → { status, lineUserId? }
DELETE /api/v1/link/{linkToken}
```

### 系統註冊（人主體操作）

```
POST   /api/v1/systems          { system, name, webhookUrl, events[], scopes[] }  → { apiKey }  ← 只回一次
GET    /api/v1/systems
PATCH  /api/v1/systems/{system} { webhookUrl?, events?, disabled? }
POST   /api/v1/systems/{system}/keys/rotate
DELETE /api/v1/systems/{system}
```

**接第 N 個垂直 = 呼叫一次 `POST /systems`。** 這是「擴張」在架構上的定義。

---

## 八、事件模型

### 進來：LINE → 平台 → 扇出

```
LINE webhook
   │  驗簽（x-line-signature）
   ▼
正規化成平台事件（行業無關的動詞）
   member.followed    member.unfollowed
   member.messaged    member.postback
   member.linked
   │
   ▼
查 system_${botId}_* 的 events 訂閱
   │
   ├──► studio  （訂閱 messaged, postback, linked）
   ├──► salon   （訂閱 messaged, followed）
   └──► shop    （訂閱 postback）
```

**事件動詞必須是行業無關的。** `member.messaged` 可以，
`project.delivered` 不可以 —— 後者是垂直後端自己的事件，
它要通知客人就呼叫 push/reply，不需要平台層定義它。

### 事件信封

```json
{
  "id": "evt_01J…",
  "botId": "…",
  "type": "member.messaged",
  "at": "2026-11-10T…Z",
  "member": { "lineUserId": "U…", "links": [{ "system": "studio", "externalId": "…" }] },
  "data": { "text": "…", "replyToken": "…" }
}
```

- `id` 做幂等 —— 收端可能收到重複
- `links` 一併帶上，收端不必再查一次「這人是我的誰」
- **不帶姓名** —— 隱私，而且垂直後端自己有名字
- 送出時加 `X-Signature: HMAC-SHA256(body, 該 system 的 secret)`

### 投遞保證

at-least-once + 指數退避重試 + dead letter。收端必須幂等。
重試不可讓客人等（背景 `waitUntil`）。

量大之後換 Cloudflare Queues（目前 `wrangler.jsonc` 裡是註解掉的，需付費方案）。

### 出去：垂直後端 → 平台 → LINE

就是第七節的傳輸 API。沒有「平台主動幫垂直後端發訊息」這種路徑 ——
那會需要平台懂業務。

---

## 九、訊息成本架構

免費額度是 per bot 且很小（輕用量 200 則/月且不可加購），而
**回覆、歡迎訊息、關鍵字自動回應都不計費**。所以成本不是營運問題，是架構問題。

### 路由原則：查詢型走免費，打擾型才付費

| 互動 | 通道 | 誰決定內容 | 計費 |
|---|---|---|---|
| 客人點 Rich Menu 查狀態 | postback → 扇出 → 垂直後端 → reply | 垂直後端 | **免費** |
| 客人傳關鍵字 | 關鍵字自動回應 | 平台層設定（後台） | **免費** |
| 剛綁定完 | 歡迎訊息 | 平台層設定 | **免費** |
| 真的需要主動告知 | push | 垂直後端 | 1 則/人 |

**設計規則：任何「客人主動想知道」的事情都不該用 push。**
把它做成 Rich Menu 項目或關鍵字，走 reply token 回答。

### 額度會計在平台層

```
quota_${botId}_${YYYYMM}  { pushed, free, plan }
```

- push 前檢查，超額回 `402 quota_exhausted` 並附 `remaining`
- 垂直後端據此決定降級（改發 email、或等客人自己來查）
- 平台層**不替垂直後端決定**要不要發 —— 只告知事實

---

## 十、安全邊界

| 項目 | 設計 |
|---|---|
| repo 是公開的 | 所有 secret 走 `wrangler secret`，不進 `wrangler.jsonc` |
| LINE access token | 不以明文存 KV。用 `crypto.subtle` AES-GCM + wrangler secret 的金鑰包起來 |
| service key | 只存 SHA-256 雜湊 |
| webhook 出去 | HMAC 簽章，每個 system 一組 secret |
| webhook 進來 | 驗 `x-line-signature`，非法簽章視為驗證失敗（不可拋成 500） |
| 認證預設 | fail-closed —— 缺設定時拒絕，不是放行 |
| dev / prod | 分開的 KV namespace，dev 不得指向 prod |
| 跨 bot | 任何 handler 不得接受呼叫端自報的 botId，只能用認證解析出來的 |
| 事件 payload | 不帶姓名、不帶 token、不帶 key |

最後兩條是多租戶的命門:**自報身分 = 橫向越權**。

---

## 十一、哪些東西留在垂直領域（誠實的邊界）

平台層省掉的是會重複寫五遍的：認證、推播、額度、CRM、標籤、身分綁定、
事件扇出、Rich Menu / 關鍵字的設定介面。

**每個新垂直仍然要自己寫：**

1. 那個行業的後端（預約、訂單、庫存 —— 業務狀態與語意）
2. Rich Menu 的版面與項目內容
3. 關鍵字集合
4. 訊息文案
5. 業務事件 → 標籤的對應規則
6. 那個行業的 LIFF 頁面（如果需要）

所以「只要 API 對就好」對**配管**成立，對**產品**不成立。
接第 N 個垂直的成本不是 0，但它是「寫一個新產品」的成本，
而不是「再造一次 LINE 基礎設施」的成本。

---

## 十二、接新垂直的程序

架構正確的話，這是一張清單而不是一個專案：

```
1. 建 bot            申請 LINE 官方帳號 → 平台建 bot_${botId}
2. 註冊 system       POST /api/v1/systems → 拿 service key（只回一次）
3. 設訂閱            events[] 選要哪些平台事件
4. 設內容            後台設 Rich Menu / 關鍵字 / 歡迎訊息（不寫程式）
5. 垂直後端接線      呼叫 push/reply/tags，收 webhook
```

**步驟 1-4 完全不改 line_manager 的程式碼。** 這就是「可擴張」的驗收標準。

---

## 十三、從現狀到這個架構

目前的落差（詳見 `AUDIT_AND_ROADMAP_2026-11-10.md`）：

| 現狀 | 目標 |
|---|---|
| KV key 綁 `${userId}`（呼叫者本人） | 綁 `${botId}` |
| 只有 `team.js` 用 `withPermission` | 所有 handler 統一 |
| 只有 LIFF + localhost 兩種認證 | 加 service key 主體 |
| 無外部系統概念 | `system_${botId}_${system}` 註冊表 |
| 無事件扇出 | 訂閱 + 扇出 + 幂等 |
| 無額度會計 | `quota_${botId}_${YYYYMM}` |
| access token 明文存 KV | AES-GCM 加密 |

### 架構上的順序（不是工期）

```
botId 統一  →  三主體認證  →  system 註冊 + 事件扇出  →  額度會計  →  第一個垂直接線
```

前兩步是地基。**先接垂直再補多租戶，等於要動一個已經在正式環境跑的整合** ——
順序錯了代價差很多。

---

## 十四、值得用測試釘住的不變量

這些壞掉的時候不會有任何程式報錯，所以要用測試守：

1. 任何 handler 都不接受呼叫端自報的 botId
2. `member_external_*` 的 key 一定含 `system` 段
3. service key 在 KV 只以雜湊存在；撤銷後立即失效
4. 事件 payload 不含姓名、token、key
5. dev 與 prod 的 KV namespace id 不相同
6. `AUTH_MODE` 的非 legacy 值一律視為最嚴格模式
7. 新增端點預設進受保護清單（公開端點要明列例外）
8. push 超額回 402 而不是靜默失敗

第 5、6、7 已經有測試（`test_wrangler_config.mjs`、`test_auth_channel.mjs`）。
