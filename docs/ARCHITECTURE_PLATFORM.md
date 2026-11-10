# line_manager 平台架構（可擴張設計）

2026-11-10 初版；2026-11-11 補上群組、reply 時限、推播防重複、封鎖、
service key 限流、資料搬遷與個資（第四之二、八、九、十、十三節）。
這份只講架構，不含實作步驟。

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

## 四之二、群組（第一版就要）

上一節只談 `lineUserId`，但推播對象不只有人。婚攝的新人群組、沙龍的
VIP 群、服飾店的團購群 —— 垂直後端需要推到一個**群組**，而 LIFF 綁定
拿不到 `groupId`（LIFF 在群組內開啟時 `getContext()` 只在特定情境給
groupId，不可依賴）。所以群組需要自己的綁定路徑。

### 推播對象是一個通用的 target，不是一個 user

```
target = { type: "user" | "group" | "room", id: "U…" | "C…" | "R…" }
```

平台層的 push 只認 target；`to` 直接就是這個 id。LINE 的
`POST /v2/bot/message/push` 本來就接受三種 id，不需要分支。

### 綁定路徑：在群組裡傳一段碼

```
垂直後端                line_manager                 群組
   │ POST /link/tokens       │                        │
   │ {system, externalId,    │                        │
   │  targetType:"group"}    │                        │
   ├────────────────────────►│                        │
   │◄────────────────────────┤                        │
   │ {linkToken, code}       │                        │
   │   code 形如 "LM-7K3QX9"  │                        │
   │                         │                        │
   │ （把 code 給使用者，請他貼進群組）                   │
   │─────────────────────────────────────────────────►│
   │                         │                        │
   │                         │◄───────────────────────┤ 有人在群組裡傳
   │                         │   webhook: message      │   "LM-7K3QX9"
   │                         │   source.groupId = C…   │
   │                         │                        │
   │◄────────────────────────┤                        │
   │ webhook: target.linked  │                        │
   │ {system, externalId,    │                        │
   │  target:{type,id}}      │                        │
```

**碼的格式必須是通用的。** 平台層只認「這是一個綁定碼」，不認它代表
一個選片專案、一次預約還是一張訂單 —— 這是第一節不變量的直接結果。
格式固定為 `LM-` + 6 碼 Crockford base32（去掉易混淆的 I/L/O/U），
一次性、預設 TTL 30 分鐘、用掉即失效。

辨識規則只有一條：收到的文字訊息 **trim 後完全等於**某個未使用且未過期
的綁定碼。不做前綴比對、不做模糊比對 —— 否則客人正常聊天會誤觸。

### bot 被踢出群組

LINE 會送 `leave` 事件（`source.groupId` 或 `roomId`）。平台層必須：

1. 把 `target_${botId}_group_${groupId}` 標成 `leftAt`，**不刪**
   （垂直後端還留著對應關係，直接刪會讓它查到 404 而不是「已失效」）
2. 扇出 `target.unlinked`，理由 `bot_left`
3. 之後對這個 target 的 push 一律回 `409 target_inactive`，不打 LINE

同樣地，`join` 事件（bot 被加進群組）在沒有綁定碼之前**不建立任何綁定**
—— 平台層不知道這個群組屬於誰。

### KV

```
link_code_${code}                            { botId, system, externalId, targetType, expiresAt, usedAt }
target_${botId}_${type}_${id}                { system, externalId, boundAt, leftAt? }
target_links_${botId}_${system}_${externalId} [{ type, id, boundAt }]   一個 externalId 可綁多個 target
```

`member_*` 保留給 `type: "user"`（CRM 主體有 profile、tag、tier）；
群組沒有 profile 也沒有 tag，走 `target_*`，不要硬塞進 member 模型。

### 不做進平台層的事

群組要不要推、什麼情況才推（例如「只有已交件才送精修連結」、
「群組預設不推播」），是**垂直後端的閘門**。平台層照單推送並回報額度。

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

`to` 是第四之二節的 target id：`U…`（人）、`C…`（群組）、`R…`（聊天室）。

回應**必須回報額度**，否則垂直後端無法做成本控制。

### 推播防重複

事件有 `id` 可以做冪等，但 push 是垂直後端主動發起的，沒有這個東西。
呼叫端重試一次（網路逾時、Worker 被回收、Queue 重送），客人就收到兩則。
**重複推播比漏推更傷** —— 漏推可以補，重複推已經打擾過了。

所以 push / multicast 接受一個冪等鍵：

```
X-Idempotency-Key: <呼叫端自己產生的字串，≤ 128 字元>
```

- 平台層以 `idem_${botId}_${system}_${key}` 記錄結果，TTL 24 小時
- 同一把 key 再來：**不打 LINE**，直接回上一次的回應，並帶
  `X-Idempotency-Replayed: true`
- 上一次還在處理中（記錄存在但沒有結果）：回 `409 in_progress`，請呼叫端稍後重試
- 沒帶這個 header 時不做去重，但回應帶 `X-Idempotency-Missing: true`，
  讓呼叫端在 log 裡看得見自己沒有保護

鍵由呼叫端決定，因為只有它知道「同一件事」的定義（例如
`deliver:project_8821:v2`）。平台層不猜。

### 推不出去的情況

| 狀況 | 回應 | 平台層同時做什麼 |
|---|---|---|
| 客人封鎖或取消好友 | `409 target_inactive`，`reason: "blocked"` | 標記 member `inactiveAt`，扇出 `member.unfollowed` |
| bot 被踢出群組 | `409 target_inactive`，`reason: "bot_left"` | 標記 target `leftAt` |
| 額度用完 | `402 quota_exhausted`，附 `remaining` | 不打 LINE |
| target 從未綁定 | `404 target_not_found` | — |

這四種都**不是 500**。垂直後端要能分辨「這個人再也推不到了，改用 email」
與「這次失敗，等一下重試」—— 混成 500 就分不出來了。

LINE 對已封鎖的對象推播時會回 403；平台層收到 403 就把 member 標成
inactive 並改回 409，不要讓這個狀態只存在於 LINE 那一側。

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
   member.followed    member.unfollowed      人：加入 / 封鎖或取消好友
   member.messaged    member.postback
   member.linked      member.unlinked
   target.linked      target.unlinked        群組 / 聊天室：綁定碼成立 / bot 離開
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

### reply token 的時限：誰有權回覆

`replyToken` **只能用一次，且約 1 分鐘內有效**（LINE 未保證確切秒數，
當成 30 秒來設計）。扇出是 at-least-once 且並行的，所以同一個事件可能
同時送到三個系統手上 —— 如果三個都想 reply，兩個會失敗，而且失敗的
那兩個不知道是自己慢了還是別人先回了。

規則：

1. **一個事件只有一個 responder。** 註冊 system 時宣告
   `canReply: true` 的系統中，同一個事件只有一個會拿到 `replyToken`，
   由訂閱設定的優先序決定（`system_${botId}_${system}.replyPriority`，
   數字小者先）。其餘訂閱者收到同一個事件，但 `data.replyToken` 為 `null`。
2. **replyToken 不進重試。** 重試投遞時一律不帶 token（它早就過期了），
   帶 `data.replyExpired: true`。收端若仍要說話，只能用 push（要算額度）。
3. **平台層自己的兜底。** responder 在 **5 秒**內沒有呼叫
   `/messages/reply`，平台層就用該 bot 設定的關鍵字／預設回應接手回覆
   （免費路徑），並在事件信封留下 `repliedBy: "platform"`。
   垂直後端慢了，客人不該面對沉默。
4. 兜底發出後 replyToken 即作廢，後到的 reply 回 `409 reply_window_closed`。

這條規則的代價是：**垂直後端的查詢型回應必須在 5 秒內完成**。做不到的
事情（算圖、跨系統查詢）就不要走 reply，先 reply 一句「查詢中」，
結果用 push 送 —— 那是一個要付費的決定，應該由垂直後端明確做出。

### 出去：垂直後端 → 平台 → LINE

就是第七節的傳輸 API。沒有「平台主動幫垂直後端發訊息」這種路徑 ——
那會需要平台懂業務。

---

## 九、訊息成本架構

免費額度是 per bot 且很小（**輕用量 200 則/月**、不可加購 —— 2026-11-11
由 Tim 確認的數字；方案異動時這裡要跟著改），而
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
quota_${botId}_${YYYYMM}  { pushed, free, plan, lineRemaining, lineCheckedAt }
```

- push 前檢查，超額回 `402 quota_exhausted` 並附 `remaining`
- 垂直後端據此決定降級（改發 email、或等客人自己來查）
- 平台層**不替垂直後端決定**要不要發 —— 只告知事實

**以 LINE 的數字為準，自己記的只是快取。** 平台自己數的 `pushed`
必然偏低：從官方帳號後台手動群發的、用別的工具發的、以及 LINE 自己
的計算方式差異，都不會進我們的計數器。只看自己的數字，會在「我們以為
還有 80 則」的時候被 LINE 擋掉。

所以：

1. push 前先看 `quota_${botId}_${YYYYMM}` 的快取做快速判斷
2. 快取顯示剩餘 **低於 20%**，或 `lineCheckedAt` 超過 **15 分鐘**時，
   先呼叫 LINE 的 `GET /v2/bot/message/quota/consumption` 與
   `GET /v2/bot/message/quota` 對帳，再決定
3. 回應裡的 `remaining` 一律回報 LINE 的數字，不是我們數的
4. LINE 真的擋下來時（429 / 額度用盡），把快取直接寫成 0 並扇出
   `quota.exhausted`，不要等下一次對帳

對帳呼叫本身不計費，但有自己的 rate limit，所以不要每則 push 都查。

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

### service key 的限流

現有的 `rate_limiter.js` 以 `userId` 當 key，而系統主體沒有 userId ——
照搬的話，所有垂直後端會共用同一個桶，或者乾淨地繞過限流。兩種都不行。

限流的 key 跟著**認證主體**走，由中間件統一決定：

| 主體 | 限流 key | 預設額度 |
|---|---|---|
| 人（staff） | `rl_user_${userId}` | 現狀不變 |
| 系統（service key） | `rl_sys_${botId}_${system}` | 每個 (bot, system) 一個桶 |
| LINE webhook | 不限流 | 進來的量由 LINE 決定 |

- 桶是 per (botId, system)，不是 per key —— 輪替金鑰不該順便重置額度
- 寫入類端點（push、tags:write）與讀取類分開計算
- 超過時回 `429` 並帶 `Retry-After`
- 額度存在 `system_${botId}_${system}.rateLimit`，可以為個別系統調高

一把被洩漏或寫壞的 service key 不該把整個 bot 的額度打爆，這是分桶的理由。

### 個資

跨系統綁定讓同一個人的資料出現在多個地方，所以邊界要先講清楚。

**誰看得到什麼：**

- 一個 system 只看得到**自己綁過的** target。
  `GET /members/by-external/{system}/{externalId}` 的 `{system}` 必須等於
  認證解析出來的 system —— 不可由呼叫端指定別人的。
- 事件信封的 `links` **只帶該收件系統自己的那一筆**，不是全部。
  否則攝影系統會從事件裡知道這個人也是某美髮沙龍的客人，
  而客人從未同意這件事。
- `displayName` / `pictureUrl` 屬於平台層 CRM，不進事件信封（第八節已定），
  垂直後端要用就明確呼叫 `GET /members/{lineUserId}`，留下存取紀錄。

**刪除請求：**

```
DELETE /api/v1/members/{lineUserId}        人主體操作，刪整個 bot 底下的這個人
```

1. 刪 `member_${botId}_${lineUserId}`、所有 `tag_members_*` 反向索引、
   `member_links_*` 與對應的 `member_external_*`
2. 對每一個曾綁定的 system 扇出 `member.deleted`，由它自己清自己那邊
   —— 平台層沒有權限也沒有能力去刪垂直後端的資料
3. 留一筆 `deletion_${botId}_${hash(lineUserId)}` 稽核紀錄
   （只存雜湊與時間，不存 id 本身），證明做過而不留下被刪的人
4. 刪除是 per bot 的。同一個 lineUserId 在別的 bot 底下的資料不受影響，
   因為那是另一個生意跟他的關係。

未綁定、純好友的 member 走同一條路徑。LINE 本身的好友關係不在我們手上，
平台層刪掉的是我們記的東西。

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
| ~~KV key 綁 `${userId}`（呼叫者本人）~~ **存取層已完成** | 綁 `${botId}`（`lib/bot_store.js`，雙讀雙寫中） |
| 只有 `team.js` 用 `withPermission` | 所有 handler 統一 |
| 只有 LIFF + localhost 兩種認證 | 加 service key 主體 |
| 無外部系統概念 | `system_${botId}_${system}` 註冊表 |
| 無事件扇出 | 訂閱 + 扇出 + 幂等 |
| 無額度會計 | `quota_${botId}_${YYYYMM}` |
| ~~access token 明文存 KV~~ **已完成** | AES-GCM 加密（`token_crypto.js` / `token_store.js`） |

### access token 加密：程式好了，資料還沒

`token_store.js` 已是唯一出口，寫入一律加密、讀取自動解密，舊的明文值
會原樣通過（`decryptToken` 對不在加密命名空間的值直接回傳）。所以：

- **既有資料還是明文。** 加密只在「重新寫入」時發生，沒有人動過的 token
  會一直是明文。需要一次性遷移：讀出每一筆 → 用 `saveAccessToken` 重存。
- **prod 必須先設好 `TOKEN_ENCRYPTION_KEY`**（`wrangler secret put`）。
  沒設的話 `saveAccessToken` 會丟錯 —— 這是刻意的 fail-closed，但表示
  **註冊新 token 會直接壞掉**，不是只有遷移受影響。這件事要先確認。

### 資料搬遷：botId 統一

機制已經建好（`lib/bot_store.js` + `migration/migrate.js`），操作步驟見
**`docs/BOTID_MIGRATION.md`**。這裡只留架構上的要點：

1. **botId 來自 LINE 的 destination**，不是發明出來的 id。
   `access_tokens_${userId}` 裡已經有了；沒有 destination 的舊 project
   無法回填，要先用它的 token 打 `GET /v2/bot/info` 補上。
2. **所有 KV 存取集中到 `bot_store`**，由它同時處理新舊 key：
   讀取新 key 優先、回退舊 key；寫入與刪除兩邊都做。
   handler 的簽章不變 —— 一次改 16 個簽章的 PR 沒有人能安全地 review。
3. **回填是複製，不是搬移。** 舊 key 一筆都不刪，所以任何一步出錯都可以
   把 handler 退回去，而不需要反向搬運。
4. **兩條不可違反的規則**（兩者都有測試）：
   - 回填絕不覆蓋已經存在的新 key。雙寫上線後，新 key 可能比舊 key 更新，
     覆蓋它等於把使用者剛改的東西換回舊版本。
   - 只回填 handler 已經切換的資源（`RESOURCES.switched`）。提前回填會留下
     一個沒人讀、卻在它切換那一刻立刻「贏」的舊快照。
5. **`bot_store` 的 `legacy_fallback` log 歸零才代表回填完成。** 這是唯一
   可靠的訊號；在那之前不要停雙寫。
6. **刪舊 key 是最後一步**，且要先有備份。

**搬一半中斷怎麼辦**：雙寫保證新舊兩邊都是對的，所以中斷時系統仍然可用，
重跑回填即可（單一使用者的回填是冪等的，整批有 KV 游標）。真正不可中斷的
只有「停雙寫」到「刪舊 key」之間 —— 那一段要一次做完。

**CRM 資料只進 current bot。** 設定類（關鍵字、Flex、圖文、快速回覆）複製到
該 owner 的每一個 bot，重複無害；會員、標籤與統計只進 `current_token` 指向的
那一個，否則同一批會員會在每個 bot 底下各出現一次。

搬遷期間 `member_external_*` 的 key 一律用新格式（含 `system` 段），
不要為了相容而生出第三種格式。

### 架構上的順序（不是工期）

```
Rich Menu 修復  →  botId 統一  →  三主體認證  →  system 註冊 + 事件扇出
                →  額度會計  →  群組綁定  →  第一個垂直接線（image picker）
```

Rich Menu 排在最前面是因為它現在就壞著、範圍又小，跟底下的改造沒有相依。

botId 統一與三主體認證是地基。
**先接垂直再補多租戶，等於要動一個已經在正式環境跑的整合** ——
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
9. 同一把 `X-Idempotency-Key` 第二次呼叫 push 時不打 LINE
10. 扇出同一個事件時，只有一個收件系統拿得到 `replyToken`
11. 事件信封的 `links` 只含該收件系統自己的綁定
12. 綁定碼只接受完全相符的文字，且用過即失效
13. 系統主體的限流桶是 per (botId, system)，不與其他系統共用
14. 推不出去的四種情況各自回 402 / 404 / 409，沒有一種是 500
15. 回填絕不覆蓋已經存在的新 key（除非明確 force）
16. 回填只處理 handler 已切換的資源
17. 回填是複製不是搬移 —— 跑完之後舊 key 一筆都沒少
18. 回填可重入 —— 跑兩次的結果與跑一次相同

第 15–18 已經有測試（`test_migration_backfill.mjs`）；雙讀雙寫本身在
`test_bot_store.mjs` 與 `test_handler_dual_write.mjs`。

第 5、6、7 已經有測試（`test_wrangler_config.mjs`、`test_auth_channel.mjs`）。
