# Image Picker 對接 LM Bridge：交接簡報

給：在私有 repo 裡開發 Image Picker 的另一個 Claude Code session（看不到本 repo）。
寫於：2026-11-18。基準：`main`，HEAD `1fa58e9`；契約 `docs/integration/bridge-v1.yaml` 版本 `1.0.0-draft`。
本文只描述 LM 這一側的介面、限制與營運事項，以及「產品端必須做到什麼」。**Image Picker 的內部設計不在本文**；需要它的地方一律寫成需求或問題。

## 0. 先讀這裡

1. **權威順序**：`bridge-v1.yaml`（契約）> 本文 > LM 各 plan 文件。本文每個數字都對照過 `worker_src/bridge/*.js`；規格與程式不一致的地方列在第 8 節，沒有自行猜測。
2. **接手後第一件事**：請 Tim 把 `bridge-v1.yaml` 原檔複製進私有 repo（例如 `vendor/lm/bridge-v1.yaml`），並在 CI 釘住它的雜湊。本文會過時，那份檔案才是契約；它的 `Error`、`Notification`、`ContactRef` 等 schema 可直接餵給 JSON Schema 驗證器（OpenAPI 3.0.3；`nullable` 需要 ajv 或同等工具支援）。
3. **標記**：`[已核對]` = 對照過程式碼；`[未驗證]` = 沒有真實環境證據（常見原因：LM 的真機驗證多為「操作者回報」，沒有逐項留證）；`[推導]` = 由程式推得、規格沒明寫。
4. **絕不把任何密鑰貼進對話、commit、log 或 issue**。本文所有密鑰位置都是佔位符（`<PRODUCT_SECRET>`、`<LINK_KEY>`）。
5. **名詞**：LM = LINE Manager（本 repo，Cloudflare Worker）；OA = LINE 官方帳號；ref = `external_contact_ref`；link = 一個產品對一個 OA 的授權關係；product = LM 營運者事先登記的外部產品。

---

## 1. 一頁摘要

**目的**：Image Picker（讓攝影師的客戶挑選照片的產品）需要用**攝影師自己的 LINE 官方帳號**，對客戶發送 LINE 通知（例如「請開始選片」「已可挑選」）。LM 負責 LINE 這一側（OA 的 token、webhook、額度、封鎖狀態、客戶的 LINE userId）；Image Picker 負責業務這一側（案件、照片、客戶資料、何時該通知）。

| 角色 | 是誰 | 在整合中做什麼 |
|---|---|---|
| LM | 管理多個 OA 的後台，Bridge 是它給外部產品的 API（`/bridge/v1`） | 同意頁、發金鑰、綁定碼、收 LINE webhook、組訊息並推送、額度與限流、稽核 |
| Image Picker | 垂直產品 | 發起連結、保管金鑰、為客戶產生 ref 與綁定碼、決定何時通知、處理所有錯誤 |
| 攝影師 | OA 的擁有者，也是 Image Picker 的租戶（假設） | 在 LM 同意頁按「同意」；在 LM 有登記自己的 OA |
| 客戶 | 攝影師的客戶，LINE 使用者 | 把綁定碼傳給攝影師的 OA；之後在 LINE 收到通知 |

**資料歸屬原則**（`ARCHITECTURE_PLATFORM.md` 第十一節）：

| 放在 LM（LINE 側） | 放在 Image Picker（業務側） |
|---|---|
| LINE userId、是否封鎖、OA token、額度、webhook 事件 | 案件、照片、客戶姓名電話 Email、挑選結果、交件進度 |

兩邊只靠一個**不透明代號 `external_contact_ref`** 接起來：Image Picker 自己產生、只在「這條連結」範圍內有意義；LM 不知道它代表誰，Image Picker 永遠拿不到 LINE userId。

**LM 提供**：授權碼流程（拿到受限金鑰）、聯絡人綁定（綁定碼 + 狀態查詢 + 解除）、受限通知 `POST /messages`（純文字標題與內文 + 最多一顆按鈕）。
**LM 不提供**（也不會）：
- LINE userId、顯示名稱、頭像（回應、稽核、log 都沒有）。
- 任意 LINE message object、圖片、群發、排程、範本（那是 `/raw/*`，只給 owner 手動發放的信任金鑰，連結流程發出的金鑰永遠不含）。
- 送達回報、已讀、訊息查詢端點（`GET /messages/{id}` 是 `planned`，**目前不存在**）；200 只代表 LINE 受理。
- 主動通知產品的 webhook（產品只能輪詢 `GET /contacts/{ref}`）。
- 群組／聊天室綁定（只支援 1 對 1 聊天室）。

**前置條件（每位攝影師）** `[推導]`：攝影師要能在 LM 同意頁選到自己的 OA，必須先是 LM 使用者、已在 LM 登記該 OA（token 與 channel secret）、是該 OA 在 LM 的 owner，且 OA 的 Webhook URL 已指向 LM。這些是 Image Picker 的攝影師上線流程要引導的事（見開放問題 Q3）。

---

## 2. 端到端流程

基底網址（正式環境，取自契約 `servers`）：`https://imhoti.tw/lm`，Bridge 在 `/bridge/v1`。下文 `$LM = https://imhoti.tw/lm/bridge/v1`。所有 API 都是**伺服器對伺服器**（不得從瀏覽器呼叫；沒有 CORS 支援）。請求與回應皆為 JSON（`Content-Type: application/json`）。

### 2.0 序列圖

```
階段 A  產品登記（一次性，LM 營運者 Tim 做；產品不參與）
  Tim ──POST /admin/products (BRIDGE_ADMIN_SECRET)──▶ LM
  Tim ◀── product_id + product_secret（只出現一次）──── LM
  Tim ──（帶外安全管道）──▶ Image Picker 保管 product_secret

階段 B  連結（每位攝影師 / 每個 OA 一次）
  攝影師(瀏覽器)      Image Picker 後端            LM                      
     │ 按「連結 LINE」      │                       │
     │───────────────────▶│ 產生 state，存進此人的 session
     │◀── 302 ────────────│                       │
     │ GET $LM/link/authorize?product_id&state&redirect_uri
     │───────────────────────────────────────────▶│ 驗證參數 → 302 同意頁（LIFF 登入）
     │ 同意頁：顯示產品名、OA、回調主機名稱；攝影師選 OA 按「同意」
     │◀── 302 redirect_uri?code=lmc_…&state=…（取消則 ?error=access_denied&state=…）
     │ GET /callback?code&state ─▶│ 驗證 state 與 session 相符、單次消耗
     │                       │ POST $LM/links/token  (Bearer product_secret)
     │                       │──────────────────────▶│ 單次消耗授權碼
     │                       │◀── link_id, service_key, scopes, bot_display_name
     │                       │ 把 service_key 存進伺服器端密鑰庫

階段 C  聯絡人綁定（每位客戶一次）
  客戶(瀏覽器)        Image Picker 後端            LM                  客戶(LINE) / OA
     │ 要綁定 LINE ─────▶│ POST $LM/contacts/bind-tokens {ref}
     │                   │──────────────────────▶│ 產碼（只存雜湊）
     │                   │◀── bind_code, bind_url|null, expires_at
     │◀── 顯示 QR/按鈕/碼 ─│
     │ 在 LINE 1 對 1 聊天室傳出 LM-XXXX-XXXX-XXXX ─────────────────────▶ OA
     │                   │                       │◀── webhook message ── LINE
     │                   │                       │ 認出碼 → 寫入綁定 → OA 回「已完成綁定，之後會在這裡通知你」
     │ 輪詢 ─────────────▶│ GET $LM/contacts/{ref}
     │                   │──────────────────────▶│
     │◀── 已綁定 ─────────│◀── {status:"bound", bound_at}

階段 D  發通知（每個業務事件）
  Image Picker 後端                              LM                        客戶(LINE)
     │ POST $LM/messages (Bearer link_key, Idempotency-Key)
     │──────────────────────────────────────────▶│ 驗證→預算→網域白名單→冪等→解析 ref→額度
     │                                           │ LINE push（Flex：標題粗體+內文+按鈕）──▶ 收到
     │◀── 200 {message_id, status:"sent", sent_at}│

階段 E  維運
  輪替金鑰 POST /links/{id}/rotate-key；解除連結 DELETE /links/{id}；解除綁定 DELETE /contacts/{ref}
  攝影師也可在 LM 後台「系統管理 → 已連結的產品」撤銷（立即生效，產品之後收到 LINK_REVOKED）
```

### 2.1 健康檢查（可選，監控用）

`GET $LM/health`，無認證。
- `200 {"ok":true}`
- `503 {"success":false,"error":"bridge_not_configured"}`（舊格式；LM 的資料庫未就緒）
- `404 {"success":false,"error":"Not Found"}`（舊格式；Bridge 旗標關閉，整個 `/bridge/*` 都是 404）

提醒：這幾種是 `LegacyError` 形狀（`{success:false,error:"…"}`），**不是** `{error:{code,…}}`。產品的 HTTP client 對非預期本文要退回「只看 HTTP 狀態」，也要容忍非 JSON（邊緣層的 HTML 錯誤頁）。`[已核對]`

### 2.2 授權：把攝影師導向同意頁

`GET $LM/link/authorize?product_id=<PRODUCT_ID>&state=<STATE>&redirect_uri=<URL-ENCODED>`（瀏覽器導覽，無標頭）

| 參數 | 規則 |
|---|---|
| `product_id` | `prd_` + 12 位小寫 hex（登記時取得） |
| `state` | 必填，1–256 字元；LM 原樣帶回，不驗證 |
| `redirect_uri` | 必須與登記值**逐字元精確相同**（不做前綴、萬用字元、正規化），≤ 2048 字元 |

- 成功：`302` 到 LM 的同意頁（`/lm/pages/link_authorize.html?…`）。
- 失敗：`400` `{"error":{"code":"INVALID_REQUEST",…}}`，**直接顯示在瀏覽器上，不會導向**；product 不存在、已停用、redirect_uri 不符都是同一個回應（不洩漏差別）。
- 同意頁顯示：產品名稱、攝影師名下可選的 OA（只列他是 owner 的）、白話權限說明、**已驗證的 redirect_uri 主機名稱**與「授權後，你的客戶可綁定並收到來自 {OA 名} 的通知」。同意頁不能被內嵌在 iframe。
- 同意後瀏覽器導向：`<redirect_uri>?code=lmc_<43 字元>&state=<原樣>`；取消則 `<redirect_uri>?error=access_denied&state=<原樣>`。授權碼 5 分鐘、單次。
- 預設授予**產品登記的全部 scope**，攝影師無法在同意頁單獨取消某一項。

### 2.3 授權碼換連結與金鑰

`POST $LM/links/token`

```http
POST /lm/bridge/v1/links/token HTTP/1.1
Authorization: Bearer <PRODUCT_SECRET>
Content-Type: application/json

{"code":"lmc_<43字元>","redirect_uri":"https://<IP網域>/<回呼路徑>"}
```

`200`（標頭 `Cache-Control: no-store`）：

```json
{
  "link_id": "lnk_<16位小寫hex>",
  "service_key": "brk_<6位小寫hex>_<約43字元base64url>",
  "scopes": ["link:manage", "contacts:bind", "messages:send"],
  "bot_display_name": "<OA 顯示名稱>"
}
```

| 狀態 | code | 意義與處理 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 缺 `code` 或 `redirect_uri`。程式錯誤 |
| 400 | `INVALID_CODE` | 碼過期、已用、不存在、`redirect_uri` 與發碼時不同、碼屬於別的產品——**五者不可區分**。請攝影師重新發起授權 |
| 401 | `INVALID_KEY` | `product_secret` 錯，或產品已被停用。不要重試；通知營運 |
| 429 | `RATE_LIMITED` | 每 (來源 IP, product_id) 每分鐘 30 次；依 `Retry-After` |
| 503 | `INTERNAL` | LM 資料庫未就緒；可退避重試 |

重要行為 `[已核對]`：
- **金鑰只出現這一次。** 回應遺失（網路斷、你的程式在儲存前崩潰）= 金鑰遺失且碼已燒掉；補救是請攝影師重新授權（見 2.10）。**先持久化 `service_key`，再對使用者顯示「連結成功」**。
- **同一產品對同一 OA 同時只有一條 active 連結。** 再次授權會立即撤銷舊連結與舊金鑰、發新的 `link_id` 與新金鑰；舊連結名下的綁定與未用綁定碼會**自動搬到新連結**（聯絡人不用重綁）。但若舊連結是被「明確撤銷」（產品 `DELETE /links/{id}` 或攝影師在 LM 後台撤銷）後才重新授權，**不搬**——所有客戶都得重新綁定。
- 回應沒有 `bot_id`。產品只看得到 `link_id` 與 `bot_display_name`（見 Q4）。
- 檢查回傳的 `scopes` 含 `messages:send` 與 `contacts:bind`，否則視為連結失敗，不要存下來當作可用。

### 2.4 查連結狀態（可選）

`GET $LM/links/{link_id}`，`Authorization: Bearer <LINK_KEY>`，scope `link:manage`。

`200`：`{"link_id","status":"active","scopes":[…],"bot_display_name","created_at","revoked_at":null}`（不含任何金鑰）。
`link_id` 不是這把金鑰所屬的連結 → `404 NOT_FOUND`。**連結已撤銷時回 `403 LINK_REVOKED`**（認證階段就擋下），不會是 `200` + `status:"revoked"`（見 Q15）。
金鑰認證**不需要** `X-Bot-Id`（那是 `/raw/*` 專用；LM 的操作手冊範例有帶，會被忽略）。

### 2.5 輪替金鑰

`POST $LM/links/{link_id}/rotate-key`，`Bearer <LINK_KEY>`，scope `link:manage`，無本文。
`200 {"service_key":"<新金鑰>"}`（`no-store`）。**舊金鑰立即失效，沒有重疊期**；只能換自己這條連結的金鑰。
- 流程：暫停送件 worker → 呼叫 → **先持久化新金鑰** → 恢復。任何 worker 收到 `INVALID_KEY` 時，先重新載入密鑰庫再試一次，仍失敗才告警。
- 回應遺失 = 新舊金鑰都拿不到 → 只能請攝影師重新授權（舊連結仍是 active，所以重新授權時聯絡人會自動搬過去）。
- 沒有排程規定；建議由產品決定輪替週期，並在懷疑外洩時立即輪替。

### 2.6 要綁定碼

`POST $LM/contacts/bind-tokens`，`Bearer <LINK_KEY>`，scope `contacts:bind`。

```json
{"external_contact_ref":"ipc_ab12cd34ef","allow_rebind":false}
```

`201`（`no-store`）：

```json
{
  "bind_code": "LM-B7K2-QX9M-4HTN",
  "bind_url": "https://line.me/R/oaMessage/@<basic_id>/?LM-B7K2-QX9M-4HTN",
  "expires_at": "2026-11-20T08:00:00.000Z"
}
```

- `external_contact_ref`：`^[A-Za-z0-9_-]{8,64}$`（見第 3 節對內容的要求）。`allow_rebind` 選填，必須是 boolean（否則 `400`），預設 `false`。
- 碼格式 `LM-` + 12 碼 Crockford base32（字母集 `0-9A-HJKMNP-TV-Z`，沒有 I L O U），60 bit，顯示為 `LM-XXXX-XXXX-XXXX`；**48 小時**、單次使用。客戶輸入時有無連字號、大小寫、前後空白都可以；訊息必須「只有」這組碼（trim 後完全相符），多一個字就不會被辨識。
- **碼只在這次回應出現**，LM 只存雜湊。
- **`bind_url` 可能是 `null`**（LM 取不到該 OA 的 basic ID，或格式怪異）。fallback：顯示 `bind_code` 與步驟「請加入官方帳號好友，在 1 對 1 聊天室傳送這組碼」。有 `bind_url` 時：做成按鈕（手機）與 QR code（桌機）；它會開啟 LINE 並預填這組碼，客戶按傳送即可。`[未驗證]`：預填連結帶連字號的碼是否被 LINE 客戶端原樣傳送（早期 8 碼版本的實測通過，12 碼版本的實測由操作者回報通過，皆無逐項證據）；客戶「尚未加好友」時預填連結的行為也未驗證。
- **同一條連結對同一個 ref 再要一次碼，舊的未用碼立即作廢**，只有最新一組有效（不吃 `Idempotency-Key`：LM 只存雜湊，無法重送同一組）。所以頁面重新整理時不要自動再要；要重顯就要由你保存（見第 3 節），或提供「重新取得」按鈕並說明舊碼會失效。
- 每連結同時有效的未用碼上限 1000（超過 `429 RATE_LIMITED`，**不帶** `Retry-After`，因為不是等一下就會好）；每連結每分鐘 30 次（`429` 帶 `Retry-After`）。

**`allow_rebind` 語意** `[已核對]`：
- 這個 ref 在這條連結下**已經被另一位 LINE 使用者綁定**時：
  - `false`（預設）：用這組碼傳訊息的人**不會**綁定、碼**不會**被消耗、OA **保持沉默**（客戶什麼都看不到）。你也看不到任何訊號（狀態仍是 `bound`，見 2.7）。
  - `true`：覆蓋綁定，並對**原綁定者**推一則「你的綁定已被更換」（盡力而為）。
- 同一位 LINE 使用者重綁自己：永遠視為成功。已是 `blocked` 的綁定也算「已被別人綁定」，換人要 `allow_rebind: true`。
- 建議：只有在**你已用自己的方式確認是該客戶本人**，且客戶明確表示「換了 LINE 帳號／要換綁」時才傳 `true`；一般首次綁定一律 `false`。
- 新發的碼會取代舊碼，包括 `allow_rebind` 不同的舊碼（新發的預設碼會取代較寬鬆的舊碼）。

### 2.7 客戶在 OA 傳碼；產品輪詢狀態

客戶在 OA 的 **1 對 1 聊天室**傳出碼。LM 的 webhook 認出後寫入綁定，OA 回覆固定文字「已完成綁定，之後會在這裡通知你」。群組／多人聊天室不處理。長得像碼但查無此碼（錯、過期、已用、別的 OA）時 **OA 完全沉默**，訊息照一般流程處理（可能觸發該 OA 的關鍵字自動回覆）。

`GET $LM/contacts/{external_contact_ref}`，`Bearer <LINK_KEY>`，scope `contacts:bind`。

`200`（`no-store`）：`{"external_contact_ref":"ipc_ab12cd34ef","status":"bound","bound_at":"2026-11-18T08:00:00.000Z"}`；`bound_at` 只有 `bound`／`blocked` 有值，其餘為 `null`。不含 LINE userId、名稱、頭像。只查**這條連結**的綁定；別條連結的 ref 看起來就是 `unbound`。路徑上的 ref 格式不合 → `404 NOT_FOUND`（不是 400）。字面上的 ref `bind-tokens` 不可用。

| status | 意義（`[已核對]` 推導規則） | 產品該怎麼做 |
|---|---|---|
| `unbound` | 沒有綁定也沒有有效未用碼（從未綁、碼過期 48 小時、已 DELETE、或別條連結的 ref） | 顯示「綁定 LINE」入口；可以要碼 |
| `pending` | 沒有綁定，但有未過期未用的碼 | 顯示「等待在 LINE 傳出綁定碼」＋碼的有效期限；允許「重新取得」 |
| `bound` | 已綁定且可發送 | 可發通知 |
| `blocked` | 客戶封鎖了 OA（unfollow 事件，或 LM 推送時 LINE 回 403） | **不要發**（LM 也會直接 `409 RECIPIENT_BLOCKED`，不打 LINE）。改用備援管道（Email 等）並提示客戶解除封鎖；客戶重新加好友（follow 事件）後 LM **自動還原為 `bound`**，產品不需做事，下次發送時自然恢復 |
| `disabled` | 連結已撤銷或產品被停用 | 實務上只會在撤銷的瞬間出現（金鑰多半已先被擋成 `403 LINK_REVOKED`）。當作 `LINK_REVOKED` 處理 |

兩個容易誤判的地方 `[推導]`，規格沒明寫（見 Q9）：
- **已有綁定的 ref 再要新碼時，狀態仍是 `bound`（不是 `pending`）**，因為「有綁定列」優先於「有待用碼」。判斷換綁是否完成，比較 `bound_at` 是否變新。
- 換綁被拒（`allow_rebind:false`）時狀態不變、OA 沉默——產品只能在逾時（碼過期或你設的等待上限）後告訴客戶「若你換了 LINE 帳號，請聯絡攝影師重新綁定」。

**輪詢建議**：客戶停留在綁定頁時，前 2 分鐘每 3–5 秒一次，之後 15 秒、30 秒、最長 60 秒；頁面關閉就停；到 `expires_at` 就停（改顯示「已過期，重新取得」）；同一 ref 同時只有一個在途請求。更好的做法：讓客戶按「我已傳出」才查一次，再配合上述退避。LM 目前**沒有**對 `GET /contacts/*` 做限流 `[已核對]`，但這不是可以濫用的理由（認證前沒有任何限流，見風險）。背景（客戶不在頁面）不要輪詢，改為在要發通知時直接發，由 `CONTACT_NOT_BOUND` 回應告訴你。

### 2.8 發通知

`POST $LM/messages`，`Bearer <LINK_KEY>`，scope `messages:send`。

```http
POST /lm/bridge/v1/messages HTTP/1.1
Authorization: Bearer <LINK_KEY>
Idempotency-Key: selection.ready:<project_id>:<contact_ref>:<revision>
Content-Type: application/json

{
  "external_contact_ref": "ipc_ab12cd34ef",
  "event_type": "selection.ready",
  "title": "照片已可挑選",
  "body": "您的照片已上傳完成，請於 7 天內完成挑選。",
  "action": { "label": "開始挑選", "url": "https://<已登記網域>/<路徑>" }
}
```

`200`（`no-store`）：`{"message_id":"msg_<16位hex>","status":"sent","sent_at":"2026-11-18T08:00:00.000Z"}`。**同步送出**：`200` 即 LINE 已受理；沒有 `202`、沒有 `accepted`、沒有送達回報。同一把 `Idempotency-Key` 重送回傳**第一次的結果（同一個 `message_id`）**並帶 `X-Idempotency-Replayed: true`，不會再發。

欄位（欄位集合封閉：多帶任何欄位 → `400`）：

| 欄位 | 規則 |
|---|---|
| `external_contact_ref` | 必填；`^[A-Za-z0-9_-]{8,64}$`；只在這條連結範圍內解析 |
| `event_type` | 必填；`^[a-z][a-z0-9_.]{0,63}$`；呼叫端自訂事件名，**不顯示給客戶**（見 Q10） |
| `title` | 必填；1–40 字元（Unicode code point）；純文字，不可全空白，不可含控制字元 |
| `body` | 必填；1–300 字元；純文字，只允許換行 `\n`（不允許 `\r`、`\t`） |
| `action` | 選填；`{label, url}`，兩者必填，不可有其他欄位 |
| `action.label` | 1–20 字元；不可含控制字元 |
| `action.url` | 見下 |

**`action.url` 規則** `[已核對]`：`https:`；無帳號密碼；埠為空或 443；主機不是 IP（含會被正規化成 IP 的怪寫法如 `0x7f.1`、`2130706433`）、不是 localhost／IPv6；長度 ≤ 1000；無空白與控制字元；主機名稱（轉小寫、去一個尾端點）**等於**產品登記的某個 `url_domains`，**或是它的子網域**（`a.picker.example.com` 屬於 `picker.example.com`；`evil-picker.example.com` 與 `picker.example.com.evil.com` 不屬於）。query 與 fragment 沒有限制。實際送給 LINE 的是正規化後的 `URL.href`。不符 → `422 INVALID_URL_DOMAIN`。沒有 `action` 的通知不查網域；沒有登記任何 `url_domains` 的產品只能發純文字。

**`title`、`body`、`action.label` 不可含 `http://` 或 `https://`（不分大小寫）** → `400 INVALID_REQUEST`；連結只能放在按鈕。注意 LM 只擋這個子字串：`www.…`、`line://`、`tel:` 之類不被擋（審查 L-03）；產品端自己的內容規範要負責不放。

**客戶看到的**：LM 組成固定外觀的 Flex bubble：標題（粗體）、內文、（有 `action` 時）一顆按鈕；通知列文字（altText）= 標題。不可自訂顏色與圖片；寄件者是攝影師的 OA。照片本身**不會**經過 LM；通知只能帶連結。

**冪等與重送** `[已核對]`：
- `Idempotency-Key` **必填**，1–128 字元，同一條連結內才算同一把鍵（不同連結互不影響）。LM 保存結果 **24 小時**；上一次仍在處理中最長 2 分鐘後可被接手。
- 同鍵同內容：回放第一次結果 + `X-Idempotency-Replayed: true`，**不吃預算**。同鍵不同內容：`422 IDEMPOTENCY_KEY_REUSE`。同鍵仍在處理中：`409 IN_PROGRESS`（可稍後用同一把鍵重試）。
- **只快取成功與確定性失敗**。確定性失敗只有一種：LINE 回 400（`INVALID_REQUEST`，訊息 `LINE rejected the message`）。其餘失敗（`CONTACT_NOT_BOUND`、`RECIPIENT_BLOCKED`、`QUOTA_EXCEEDED`、`RATE_LIMITED`、`INTERNAL`）**都不快取**：之後客戶可能完成綁定或解除封鎖，用同一把鍵重送會重新判斷。這與 `/raw/*` 不同。
- 驗證類錯誤（400／422 網域／413）發生在冪等登記**之前**，不佔用鍵：修好內容後可用同一把鍵重送。但被快取的 LINE 400 例外：修改內容後必須換新鍵（否則 `IDEMPOTENCY_KEY_REUSE`）。
- 網路層逾時（沒收到回應）：**用同一把鍵重送是安全的**（LM 冪等 + 推送時帶 LINE retry key，LINE 回 409 視為已送達）。

**處理順序**（決定錯誤優先序）：認證 → `Idempotency-Key` → 本文大小與 JSON → 欄位驗證 → 扣發送預算（每分鐘→每聯絡人每小時→每日）→（有 `action` 時）網域白名單 → 搶佔冪等鍵 → 解析 ref → 取 bot token → OA 月額度 → LINE push。

**預算規則** `[已核對]`：格式錯誤（400）不扣任何預算；網域不合（422）只保留每連結每分鐘那一格；冪等重送（回放、`IN_PROGRESS`、鍵重用）把名額還回去，但限流仍先判斷，所以預算已滿時連重送也會得到 `429`；`CONTACT_NOT_BOUND`、LINE 失敗等其餘嘗試都算一次。

錯誤與處理建議見附錄 A；退避策略見第 3 節。

### 2.9 解除綁定

`DELETE $LM/contacts/{external_contact_ref}`，`Bearer <LINK_KEY>`，scope `contacts:bind`。刪除綁定並作廢該 ref 所有綁定碼；**冪等**：不論原本有沒有都 `204`（不洩漏 ref 是否存在過）。用於「客戶要求刪除」或客戶離開專案。客戶之後若再要綁定，要重新要碼。

### 2.10 解除連結與重新授權

`DELETE $LM/links/{link_id}`，`Bearer <LINK_KEY>`，scope `link:manage`：`204`，立即生效，舊金鑰此後回 `403 LINK_REVOKED`。**兩邊的產品資料都不刪除**（LM 的 `contacts` 列與客戶的 LINE userId 仍留在 LM 的資料庫，見風險 L-07）；所以**租戶離開時，先逐一 `DELETE /contacts/{ref}`，再 `DELETE /links/{id}`**（連結撤銷後你就不能再呼叫 contacts 了）。

重新授權（任何原因）：重做 2.2–2.3。是否保留綁定的規則見 2.3。收到新金鑰後，**用新的 `link_id` 與金鑰整組取代**本地紀錄，不要保留舊的。

---

## 3. 產品端必須做到的事（MUST）

每條附理由。標 `[審查]` 的來自 `lm-3e-security-review.md`。

### 3.1 授權流程

1. **`state` 必須不可預測、綁定發起者的 session、回調時驗證**。至少 128 bit CSPRNG、base64url、≤ 256 字元；存在伺服器端並綁定「按下連結的那位攝影師」的登入 session；回調時比對（常數時間）、**單次使用**、設定短 TTL（建議 15 分鐘，同意頁含 LIFF 登入可能要一陣子）；缺少或不符一律拒絕整個回調，**不要**消耗 `code`。理由：LM 只原樣回傳 `state`、不替你驗證。沒驗證的話，攻擊者（你的另一個租戶）可把「他自己發起的授權」塞進受害攝影師的瀏覽器，受害者的 OA 就被掛到攻擊者的租戶上，攻擊者即可用該 OA 的名義對客戶發通知並耗盡額度（M-03；契約 `/link/authorize` 以 MUST 明載）。`[審查]`
2. **`redirect_uri` 必須事先登記且精確比對**。登記的是完整 URL（https、無 fragment、無帳號密碼、不可預先帶 `code`／`state`／`error` 參數）；授權與換碼兩次的 `redirect_uri` 必須逐字元相同。不要在回調路由上做開放轉址、不要用萬用字元式的動態路徑。多個環境（staging／prod）要分別登記（或各登記一個產品，見 Q2）。
3. **回調處理**：先驗 `state`，再看 `error`（`access_denied` 時回到「已取消」頁；也要容忍未知的 `error` 值），再用 `code` 立即換金鑰（5 分鐘、單次）。換完立即導向**不含 `code`** 的乾淨網址；`code` 不得進 access log、錯誤追蹤、Analytics、`Referer`（回調頁設 `Referrer-Policy: no-referrer`）。
4. **`product_secret` 與連結金鑰只存伺服器端**：密鑰管理服務或加密欄位（靜態加密）；不進前端 bundle、不進 URL、不進 log／錯誤追蹤／Sentry 類服務的 breadcrumb、不進測試快照、不進 git。log 只可記金鑰的前綴（`brk_` 後 6 碼 hex，非秘密）。
5. **一個 OA 只能連到一個租戶**：LM 對同產品同 OA 只允許一條 active 連結，後來者會撤銷前者。產品要在自己這邊防止兩個租戶連同一個 OA（`bot_display_name` 相同時警告；見 Q4），並能優雅處理「我的連結被取代」（`LINK_REVOKED`）。

### 3.2 `external_contact_ref`

6. **ref 是不透明代號，不得含姓名、電話、Email、LINE 相關字串，也不要用可由這些推導的雜湊**。建議：`ipc_` + 16 位以上 CSPRNG 字元（格式 `^[A-Za-z0-9_-]{8,64}$`），每位客戶（在每個租戶內）一個，**不要用流水號**。理由：LM 的稽核與計數鍵不存 ref 明文，但 ref 會出現在你呼叫的 URL（路徑）與 LM 的 D1；它必須無法回推客戶身分。
7. **產品自己保存 ref ↔ 客戶 的對照**（LM 不知道也不會告訴你）。同一位客戶在不同租戶用不同 ref。
8. **綁定碼等同一次性密碼**：誰傳出這組碼，誰的 LINE 就被綁到這個 ref，之後該客戶的通知（可能含該客戶專屬連結）就送給他。所以顯示碼／`bind_url` 的頁面必須只有「該 ref 的客戶本人」看得到（沿用產品現有的客戶存取機制，需確認；見 Q12），不得 email 給第三人、不得放在公開頁、不得進 log。若為了頁面重新整理而保存碼，要加密、設 ≤ 48 小時 TTL、綁定該客戶 session。

### 3.3 發送

9. **冪等鍵設計**：用「同一件事」定義，且重送時**必然相同**。建議 `{event_type}:{project_id}:{contact_ref}:{revision}`，例如 `selection.ready:prj_9f3a…:ipc_ab12cd34ef:1`。規則：≤ 128 字元（過長就用 SHA-256 hex 當作鍵）；不含姓名等個資；`revision` 在「刻意再通知一次」或「內容改變」時才遞增；鍵不是亂數、也不是時間戳（否則重送會變成重複發送）。**LM 只保存 24 小時**：超過 24 小時的自動重送可能重複發出，產品的 outbox 要設「超過 24 小時就不再自動重送，改為人工確認」。
10. **Outbox 模式**：先把「通知意圖 + 冪等鍵 + 內容」持久化，再呼叫 LM；`200` 後標記完成；程序在送出與標記之間崩潰時，用同一把鍵重送是安全的。不要在請求處理的同步路徑裡內嵌重試迴圈拖住使用者。
11. **429 `RATE_LIMITED`**：讀 `Retry-After`（秒，≥ 1），加 0–20% 的隨機抖動後用**同一把鍵**重試；沒有 `Retry-After` 就退避。注意兩個天花板：每聯絡人每小時 10 則、每連結每分鐘 60 則——批次事件（例如整個案件的 200 位客戶）要排隊平滑發送，不要同時衝出。同一客戶短時間內多個事件要**合併成一則**。
12. **402 `QUOTA_EXCEEDED`**：不是等幾秒就會好。兩種來源（每連結每日預算 500 則；OA 當月 LINE 額度用盡）用同一個 code，**不要解析 `message` 區分**。處理：暫停這條連結的發送、保留待發通知（不要丟棄）、在攝影師的畫面顯示「LINE 通知額度已用完」；每日預算於 **UTC 日界（台灣時間 08:00）** 重置，建議退避到下一個整點檢查，最長間隔 1 小時；月額度用盡則等到下個月或請攝影師升級 OA 方案。不要用大量重試去「探測」是否恢復。
13. **409**：看 `error.code`，不要只看狀態碼。
    - `CONTACT_NOT_BOUND`：客戶尚未綁定或已被解除。不重試；通知使用者介面顯示「客戶尚未綁定 LINE」，改用備援管道。客戶之後完成綁定，同一把鍵再送會被重新判斷（失敗不快取）。
    - `RECIPIENT_BLOCKED`：客戶封鎖了 OA。不重試；本地標記為 blocked、改用備援管道；客戶解除封鎖後 LM 自動還原，你下次送出就會成功（`GET /contacts/{ref}` 可確認）。
    - `IN_PROGRESS`：同鍵請求還在處理，1–5 秒後以同一把鍵重試（最多幾次，之後視為未知）。
14. **重送行為**：網路逾時、`5xx`、`429`、`409 IN_PROGRESS` → 同一把鍵重送。`400`、`401`、`402`、`403`、`409 CONTACT_NOT_BOUND／RECIPIENT_BLOCKED`、`422`、`413` → 不自動重送。`500／502／503`：指數退避（例如 1s、2s、4s、8s，抖動），最多 5 次或 15 分鐘，之後進入「待人工處理」，並對攝影師顯示狀態；503 且 `message` 為 `bot_not_configured` 屬 OA 設定問題（不會自己好），建議最多再試 3 次就提示攝影師檢查 LM 裡的 OA 設定（見 Q7）。
15. **不得把 LM 的錯誤訊息原文顯示給終端客戶**。`message` 是英文診斷字串、可能改版、不是契約；用 `error.code` + HTTP 狀態決定行為，顯示你自己的 zh-TW 文案。客戶永遠不應看到技術錯誤；攝影師畫面顯示可行動的狀態（「客戶尚未綁定」「LINE 連結已中斷，請重新連結」）。`message` 只進伺服器端 log（長度截斷），且確認不含密鑰（它不含）。
16. **`LINK_REVOKED`（403）**：這條連結已被撤銷、被取代，或產品被營運停用。立即**停止該租戶所有對 LM 的呼叫**、把連結標為「已中斷」、保留待發通知（建議保留 7 天後過期）、在攝影師畫面顯示「請重新連結 LINE 官方帳號」。**不要自動重新發起授權**（需要人同意）。重新授權後用新金鑰；是否需要客戶重綁見 2.3（被明確撤銷後重新授權 = 全部客戶需重新綁定；重新授權不要假設本地的 `bound` 紀錄仍正確，下次發送遇到 `CONTACT_NOT_BOUND` 時再更新）。`SCOPE_DENIED`（403）= 程式或連結設定錯誤，不重試、告警。
17. **`401 INVALID_KEY`**：金鑰錯、被輪替掉、或不是連結金鑰。先重新載入密鑰庫重試一次（可能是輪替競態），仍失敗就把連結標為「需要處理」並告警；不要無限重試（也不要用同一把壞金鑰洪水式呼叫）。
18. **輪詢不要過密**（見 2.7）；同一客戶同時只有一個在途請求；頁面不可見就停。
19. **逾時設定**：LM 呼叫到 LINE 時**沒有逾時**（審查 L-12），所以請求可能掛很久。產品端 client 設 15–30 秒總逾時，逾時按「結果未知」處理（用同一把鍵重送）。
20. **不要在前端或客戶端呼叫 LM**，也不要把 `link_id`、`service_key` 回給前端。

### 3.4 內容與隱私

21. 通知文字只放客戶本來就知道的資訊（不放姓名以外的個資、不放密碼、不放可直接登入的長效連結）。按鈕連結建議使用有期限、範圍受限的存取憑證，因為 LINE 通知會留在客戶手機與（若客戶轉傳）他處。
22. 遵守內容限制：不放 `http(s)://` 在文字內；不放 `www.` 網域、`line://`、`tel:` 等繞過（雖然 LM 不擋）。LM 只擋最基本的一層，濫用時仍可由攝影師撤銷連結（立即生效），產品的名譽風險在你。
23. 稽核與 log：不要記 LM 回的任何綁定碼、金鑰；`message_id` 可記（對帳用，LM 稽核也記它）。

---

## 4. 產品端工單清單（Image Picker 側）

**對照說明**：Image Picker 側的工單 `0B、1C、2B、3C、3D` 的定義在私有規格書，**本 repo 的 `gap-analysis.md` 只有 LM 側工單**（LM-0A…LM-3E），看不到它們。下表的編號（IP-n）是我依 LM 契約推導的清單；與私有編號的對照**只是推測，請接手 session 與私有規格書核對，Tim 確認**：

| 本文 | 推測對應 | 依據 |
|---|---|---|
| IP-0 | 0B（IP 現況盤點、與 LM 的差距） | LM 側有 WP-0A（LM 現況）、WP-0C（差距分析），0B 可能是 IP 現況 `[推測]` |
| IP-1 | 1C（金鑰與 client 基礎設施） | 無法由本 repo 推得 `[推測]` |
| IP-2 | 2B（連結流程，對應 LM-2A） | LM-2A 與其對偶工單同階段 `[推測]` |
| IP-3 | 3C（綁定，對應 LM-3A） | `[推測]` |
| IP-4 | 3D（通知，對應 LM-3B） | `[推測]` |
| IP-5 | 與 LM-3E 共同 | `gap-analysis` LM-3E：「與另一個產品端對端；故障演練；安全審查」，相依「對方的工單」 |

### IP-0　現況盤點與接縫確認 `[推測 0B]`
- **做什麼**：盤點 IP 現有的：租戶／攝影師模型、客戶身分與存取機制（客戶怎麼進入選片頁）、通知現況（Email 等）、密鑰管理方式、背景工作／佇列、對外 HTTP client、log 與錯誤追蹤的脫敏機制。回答第 8 節與本節標示給 IP 的問題。
- **驗收**：一份寫在私有 repo 的對照表：「LM 契約需求 → IP 現有能力／缺口」；至少涵蓋：state 綁 session、密鑰靜態加密、outbox、備援通知管道、客戶本人才看得到綁定碼的存取機制。
- **相依**：無。
- **測試**：文件審閱；缺口各開工單。

### IP-1　金鑰與 LM client 基礎 `[推測 1C]`
- **做什麼**：(a) 密鑰庫：存 `product_secret`（每環境一個）與每租戶的 `link_id`＋`service_key`（靜態加密）；(b) 一個窄的 `LmClient`：封裝 `$LM` 基底網址、`Authorization`、逾時、錯誤解析（`{error:{code,message,retryable}}` 與 legacy 形狀與非 JSON 都要容忍）、`Retry-After` 解析、log 脫敏（過濾 `Authorization`、`bps_`、`brk_`、`lmc_`、`LM-…` 綁定碼樣式）；(c) 以 `bridge-v1.yaml` 為基準的型別／schema 驗證；(d) 假 LM 伺服器（見第 6 節）。
- **驗收**：單元測試證明：金鑰不出現在任何 log／錯誤物件；所有附錄 A 的 code 都有對應處理分支；解析容忍 `502` HTML、空本文；逾時被當作「結果未知」。
- **相依**：IP-0。
- **測試**：對假 LM 伺服器的 client 單元／契約測試；log 掃描測試（斷言樣式不外洩）。

### IP-2　連結流程（授權碼）`[推測 2B]`
- **做什麼**：「連結 LINE 官方帳號」按鈕 → 產生並存 `state` → 導向 `$LM/link/authorize` → 回調路由（驗 state、處理 `error`）→ `links/token` 換金鑰 → 存庫 → 顯示連結狀態（`bot_display_name`、已連結／已中斷）；「重新連結」「中斷連結」（`DELETE /links/{id}`，且租戶離開時先刪綁定）；金鑰輪替（`rotate-key`）與排程；`LINK_REVOKED` 的全域處理（見 3.3 第 16 條）；攝影師上線說明（需要在 LM 登記 OA 並設好 webhook，見 Q3）。
- **驗收**：
  1. 正常流程完成後可成功呼叫 `GET /links/{id}`。
  2. `state` 缺少／不符／重放／過期的回調全部被拒，且**不**呼叫 `links/token`。
  3. 取消（`error=access_denied`）回到可重試的畫面。
  4. 同一個 OA 被第二個租戶連結時有警示；被取代的租戶顯示「連結已被取代」。
  5. 金鑰輪替後舊金鑰不再被使用；輪替回應遺失時的救濟流程（重新授權）可走通。
  6. `code`、金鑰不出現在 log 與 Referer。
- **相依**：IP-1；LM 已登記產品（第 5 節）、`redirect_uri` 已登記。
- **測試**：對假 LM 的整合測試（含負向）；真機劇本第 1–6 步。

### IP-3　聯絡人綁定 `[推測 3C]`
- **做什麼**：為每位客戶產生 ref 並保存對照；綁定頁（僅該客戶本人可見）：呼叫 `bind-tokens`、顯示 QR／按鈕／碼（`bind_url` 為 `null` 時的文字 fallback）、倒數 48 小時、「重新取得」（說明舊碼失效）；輪詢狀態（3.3 第 18 條與 2.7）；`bound`／`blocked` 的狀態顯示與備援；`allow_rebind` 的使用決策（IP 自己決定是否提供「換 LINE 帳號」功能）；客戶刪除（`DELETE /contacts/{ref}`）。
- **驗收**：
  1. 新客戶可在手機完成綁定、狀態轉 `bound`。
  2. `bind_url: null` 時頁面仍可完成綁定（文字 fallback）。
  3. 已綁定 ref 以預設碼被另一個 LINE 帳號使用：不覆蓋，頁面不顯示成功（逾時後給正確引導）。
  4. 換綁（`allow_rebind:true`）完成以 `bound_at` 變新判定。
  5. `blocked` 時不發送、顯示備援。
  6. 綁定碼不出現在 log；非該客戶無法看到。
- **相依**：IP-2。
- **測試**：假 LM + 真機（第 6 節劇本）。

### IP-4　通知發送 `[推測 3D]`
- **做什麼**：outbox + 冪等鍵設計（3.3 第 9–10 條）；事件 → 通知文案（zh-TW，≤ 限制）與按鈕網址（在登記網域內）；全部錯誤碼處理（附錄 A）；每聯絡人／每連結的合併與平滑；`LINK_REVOKED`／`QUOTA_EXCEEDED` 的暫停與恢復；攝影師畫面的通知狀態（待送／已送／被封鎖／未綁定／需處理）；備援管道。
- **驗收**：
  1. `200` 後客戶手機收到（標題、內文、按鈕）。
  2. 同鍵重送不產生第二則；程序在「已送出、未標記」之間崩潰後重送不重複。
  3. 每個錯誤碼走到預期分支（對假 LM 逐一模擬）。
  4. 批次事件被平滑在 60/分鐘、10/小時/客戶之內（不依賴 LM 擋）。
  5. 日預算耗盡時進入暫停、待發通知保留、隔日恢復。
  6. 錯誤訊息原文不出現在客戶可見畫面。
- **相依**：IP-3。
- **測試**：單元（鍵產生穩定性、合併）、對假 LM 的故障注入、真機劇本第 7–14 步。

### IP-5　端對端與故障演練（與 LM-3E 共同）
- **做什麼**：在真實 LM + 真實 OA 上跑第 6 節的驗收劇本，並**保留每一步的證據**（狀態碼、`error.code`、時間，不含金鑰與碼）；跑第 6.4 節的故障演練。
- **驗收**：第 6.5 節的出口條件。
- **相依**：IP-1…IP-4；LM 側已部署且 0001–0004 已套用。
- **測試**：同上。

### 4.1 Image Picker 自己的設計決定（LM 不干涉，也不會替你做）

租戶／攝影師模型與帳號；客戶如何驗證身分與進入選片頁；ref 的產生方式與儲存；通知時機、文案、語言、頻率策略；outbox／佇列／排程實作；重試的具體時間表（只要符合第 3 節的退避原則）；備援管道（Email 等）；密鑰庫選型；攝影師畫面如何呈現連結與綁定狀態；是否提供「換 LINE 帳號」功能（`allow_rebind`）；按鈕連結指向哪裡與其存取憑證設計；輪詢 UI 與 QR 的呈現；多環境（staging／prod）如何分別登記；資料保存與刪除政策（含客戶要求刪除時的作法，只要記得同時呼叫 `DELETE /contacts/{ref}`）。

LM 固定、產品不能協商的：欄位格式與長度、網域白名單規則、預算與限流數字（第 9 節）、錯誤碼與冪等語意、綁定碼格式與 TTL、通知外觀、一個 OA 對一個產品只有一條 active 連結。

---

## 5. LM 營運者（Tim）在對接開始前要做的事

勾選清單。每個資料庫（`bridge-db` 正式、`bridge-db-dev` 開發）各做一次。**絕不把任何密鑰貼進對話、文件或 commit。**

### 5.1 遷移與旗標

- [ ] **遷移 0001–0007 都已套用**（D1 Console 逐檔貼上，每檔每庫只貼一次；`ALTER TABLE` 不可重複）。驗證：

```sql
SELECT type, name FROM sqlite_master
 WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
 ORDER BY type, name;
```

  預期 table（14 張）：`audit_log`、`auth_codes`、`bind_codes`、`contacts`、`counters`、`event_fallbacks`、`flags`、`idempotency`、`identity_channels`、`identity_codes`、`links`、`products`、`service_keys`、`systems`；
  預期 index（13 個）：`idx_audit_log_bot_at`、`idx_auth_codes_expiry`、`idx_bind_codes_expiry`、`idx_bind_codes_ref`、`idx_contacts_user`、`idx_counters_window`、`idx_idempotency_expiry`、`idx_identity_codes_expiry`、`idx_links_bot`、`idx_service_keys_link`、`idx_service_keys_system`、`uq_links_active`、`uq_products_key`（可能另有 `sqlite_autoindex_*`，已被上面條件排除）。

  欄位驗證（每句都不能報錯）：

```sql
SELECT link_id FROM service_keys LIMIT 1;             -- 0002 的 ALTER
SELECT allow_rebind FROM bind_codes LIMIT 1;          -- 0004 的 ALTER
SELECT segment FROM contacts LIMIT 1;                 -- 0005 的 ALTER
SELECT product_key, event_url, event_secret_enc, identity_return_uris FROM products LIMIT 1;
                                                      -- 0005／0006／0007 的 ALTER
```

  缺 0004 時：`POST /messages` 與 `POST /contacts/bind-tokens` 回 `503 bridge_not_configured`，webhook 的綁定碼辨識安靜失敗（fail-closed，不是放行）。缺 0005–0007 時，分眾、事件轉發、身分換 ref 各自不啟用（公開端點回「未啟用」、營運與後台端點回 `503 bridge_not_configured`），同樣是 fail-closed。

  **D1 Console 逐句執行時，一句失敗不會中止後面的句子**，容易留下「半套用」的資料庫（實際發生過：`bridge-db-dev` 缺 0003／0004，連帶 0005 的 `ALTER TABLE contacts` 失敗，但同檔的 `products` ALTER 成功）。貼完每一檔都跑一次上面兩段驗證。

- [ ] **Worker 設定**（Cloudflare 控制台 → Workers → `pinti-line` → Settings → Variables and Secrets；dev 是 `pinti-line-dev`）：

| 名稱 | 型別 | 值／說明 |
|---|---|---|
| `BRIDGE_ENABLED` | Variable（Text） | `1`（只認精確字串 `1`）。關閉時整個 `/bridge/*` 回 404。註：`lm-2a-plan` §15 步驟 1 寫成 Secret，`gap-analysis` 寫 Variable；程式只讀字串值，兩種都有效，建議 Variable（見 Q14） |
| `BRIDGE_ADMIN_SECRET` | **Secret** | 登記產品用。`openssl rand -base64 32` 產生；程式沒有強度檢查（審查 L-10），請務必夠長（≥ 32 字元）。未設定時登記端點回 404。登記完成後可以保留（要登記更多產品時才需要），不外流 |
| `BRIDGE_LINK_DAILY_CAP` | Variable（可選） | 每連結每日預算，預設 500；正整數，其他值一律用預設。**全域，所有連結同一數字**（見 Q5） |
| `BRIDGE_ALLOW_LOCALHOST_REDIRECT` | — | **正式環境不要設**（只給本機測試） |
| `AUTH_MODE` | 既有 `liff` | 不要改成 `legacy`（審查 I-06） |
| `WEBHOOK_GLOBAL_SECRET_DISABLED` | 見 5.4 | |

- [ ] `GET https://imhoti.tw/lm/bridge/v1/health` 回 `{"ok":true}`。

### 5.2 登記產品

登記是 Tim 專屬操作（營運密鑰）。**每個環境各登記一次**（staging 與 prod 的 `redirect_uris` 不同；各自拿到不同的 `product_id` 與 `product_secret`）。要先向 IP 側取得：callback 完整 URL、按鈕目標的網域。

```bash
read -rs ADMIN; export ADMIN          # 貼上 BRIDGE_ADMIN_SECRET，不顯示
curl -sS -X POST "https://imhoti.tw/lm/bridge/v1/admin/products" \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{
        "name": "<產品名稱，同意頁會顯示給攝影師>",
        "redirect_uris": ["https://<IP網域>/<回呼路徑>"],
        "url_domains": ["<IP網域>"],
        "scopes": ["link:manage", "contacts:bind", "messages:send"]
      }'
# 201 → { "product_id": "prd_<12hex>", "product_secret": "<PRODUCT_SECRET>", "name", "redirect_uris", "url_domains", "scopes" }
```

| 欄位 | 怎麼填 | 驗證規則 `[已核對]` |
|---|---|---|
| `name` | 攝影師在同意頁看到的名稱，請用大家認得的產品名 | 1–100 字元，無控制字元 |
| `redirect_uris` | IP 回調的完整 https URL，**一字不差**（含結尾斜線、query） | 1–10 個；https；無 `#`、無帳號密碼；不可含 `code`／`state`／`error` query；正式環境不可是 localhost；≤ 2048 字元；之後逐字元精確比對，要改就重登記或改 D1 |
| `url_domains` | 通知按鈕目標所在的網域（子網域自動包含）。**只填 IP 自己的網域**（例如 `picker.example.com`），**絕不填公共後綴**（`github.io`、`pages.dev`、`co.uk`、`com.tw`、`workers.dev` 等）——程式不擋（審查 L-04），一旦登記，該後綴下任何人的子網域都能當按鈕目標 | 0–20 個；小寫主機名稱，無 scheme／埠／萬用字元；沒填就只能發純文字 |
| `scopes` | 建議三個全給：`link:manage`（查／輪替／解除）、`contacts:bind`、`messages:send`。`raw:push`、`messages:push` 一律被拒 | 非空，限這三個 |

- [ ] `product_secret` **只出現這一次**。立刻用帶外安全管道交給 IP 側保管（密碼管理器／雲端密鑰服務；不要走聊天、email、issue、commit）。
- [ ] 緊急停用：`UPDATE products SET disabled = 1 WHERE product_id = '<prd_…>';`（立即生效：新授權與換碼被拒、既有連結金鑰回 `LINK_REVOKED`；恢復改回 0）。
- [ ] 注意：**沒有產品密鑰輪替或停用的 API**（審查 I-08），遺失或外洩只能手動處理（見 Q11）。

### 5.3 測試資料清理（對接前，正式 `bridge-db`）

過去的真機驗證（2A-3、3A-2、3B-2、M-01～M-03 確認）留下了測試產品、連結、聯絡人。對接前清掉，避免干擾（尤其是你自己的 LINE 帳號已綁定在舊測試 ref 上）。**先盤點、確認 `product_id` 是測試用的再動手；不要 SELECT `line_user_id`。**

```sql
-- 盤點
SELECT product_id, name, disabled, created_at FROM products;
SELECT link_id, product_id, bot_id, status FROM links;
SELECT link_id, external_contact_ref, status FROM contacts;
SELECT link_id, COUNT(*) AS n FROM bind_codes WHERE used_at IS NULL GROUP BY link_id;

-- 停用每一個測試產品（金鑰立即變 LINK_REVOKED）
UPDATE products SET disabled = 1 WHERE product_id = '<測試 prd_…>';

-- 清掉測試連結名下的綁定與碼（含你自己的測試綁定）
DELETE FROM contacts   WHERE link_id IN (SELECT link_id FROM links WHERE product_id = '<測試 prd_…>');
DELETE FROM bind_codes WHERE link_id IN (SELECT link_id FROM links WHERE product_id = '<測試 prd_…>');
```

- [ ] 後台「系統管理 → 已連結的產品」把測試連結撤銷（比手寫 SQL 安全）。
- [ ] 不要刪 `products` 與 `links` 列（稽核引用）；`counters`、`idempotency`、`audit_log` 可保留。
- [ ] 若 IP 要先在正式 OA 做冒煙測試，請改用**另一個專用測試 OA** 與獨立的 staging 產品登記，避免汙染真實攝影師的 OA。

### 5.4 OA 與 webhook

- [ ] 每個要用 Bridge 的 OA：在 LM「個人設定 → 編輯專案」填 **Channel Secret**（`POST /token/channel-secret`；每個 LINE channel 的 secret 不同）。`GET /token/channel-secret?project=…` 可查是否已登記。沒登記的 OA 會退回全域 `LINE_CHANNEL_SECRET` 驗簽，只有 secret 恰好相同的那個 OA 能通過，其他 OA 的 webhook 全部 401——**綁定碼無法被辨識**。
- [ ] 每個 OA 的 LINE Developers Console：Webhook 開啟、URL 指向 LM、按 Verify 成功。
- [ ] **何時把 `WEBHOOK_GLOBAL_SECRET_DISABLED` 設為 `1`**：所有要用的 OA 都登記好 channel secret、且逐一 Verify 通過之後；**在開放給任何第二位攝影師／多租戶之前**一定要做。
  - 為什麼：不關的話，持有全域 channel secret 的人可對任何「未登記」的 OA 偽造事件（審查 L-08）：任意 LINE userId 的 message 事件（繞過猜碼的 per-user 嘗試上限）、任意使用者的 unfollow（把他們的綁定標成 blocked）。
  - 風險：關掉之後，**任何尚未登記 channel secret 的 OA 的 webhook 立刻全部 401**（不只 Bridge，連 LM 的關鍵字回覆、歡迎訊息等也失效），且 LINE 側可能顯示 webhook 錯誤。先逐一 Verify 再關。
  - 退路：把變數刪除或改回非 `1`，立即恢復退回全域密鑰的行為。
  - 單一受信任產品、只有 Tim 自己的 OA 時，審查結論是「不是阻擋條件」。

### 5.5 對接期間

- [ ] 稽核查詢（D1 Console）：`SELECT at, action, result, bot_id, detail FROM audit_log ORDER BY id DESC LIMIT 50;`，關注 `code_exchange_failed`、`bind_rejected`、`bind_paused`、`usage_high`、`message_failed`、`message_blocked`。
- [ ] 營運手冊要告訴 IP 側的聯絡窗口：產品密鑰遺失、停用、`BRIDGE_LINK_DAILY_CAP` 調整都要找 Tim。

---

## 6. 測試與驗收

### 6.1 不打正式 LINE 的測試：自建 LM 假伺服器（強烈建議）

用 `bridge-v1.yaml` 做一個本機／CI 內的假伺服器，依下表實作**行為**（不只形狀）。目的：開發期間不用真 OA，也能逐一演練錯誤。

| 要實作 | 行為 |
|---|---|
| `GET /link/authorize` | 驗證 `redirect_uri` 與登記值逐字元相等，否則 `400 INVALID_REQUEST`（不導向）；通過後直接 302 到 `redirect_uri?code=lmc_<43 字元>&state=<原樣>`（跳過同意頁）；提供測試開關回 `error=access_denied` |
| `POST /links/token` | 驗 product secret；碼單次使用（第二次 `INVALID_CODE`）；5 分鐘過期；`redirect_uri` 不符 `INVALID_CODE`；成功時撤銷同產品同 OA 的舊連結並搬移聯絡人 |
| `GET/DELETE /links/{id}`、`POST …/rotate-key` | 舊金鑰輪替後立即 `INVALID_KEY`；撤銷後回 `403 LINK_REVOKED` |
| `POST /contacts/bind-tokens` | `LM-XXXX-XXXX-XXXX`、48 小時、新碼作廢舊碼；`allow_rebind` 非 boolean → 400；測試開關讓 `bind_url` 為 `null`；單連結上限 1000 → 429 無 `Retry-After` |
| 測試用「客戶傳碼」入口（假伺服器專屬後門） | 模擬 webhook：預設綁定；已被別人綁定且碼未許可 → 靜默拒絕；`allow_rebind` → 覆蓋 |
| `GET/DELETE /contacts/{ref}` | 五種狀態；`DELETE` 永遠 204；路徑 ref 不合 → 404 |
| `POST /messages` | 全部驗證規則（附錄 C）；冪等（同鍵同內容回放 + 標頭；不同內容 422；處理中 409；24 小時 TTL；失敗類不快取，LINE 400 快取）；預算（60/分、10/小時/ref、日預算 → 402；`Retry-After`）；網域白名單；`CONTACT_NOT_BOUND`／`RECIPIENT_BLOCKED` |
| 故障注入開關 | 逾時、`502`/`503` HTML、非 JSON、空本文、`bot_not_configured`、回應遺失（伺服器已處理但客戶端沒收到）、`429` 帶／不帶 `Retry-After` |

**避免假伺服器漂移**：假伺服器的每個回應都用 `bridge-v1.yaml` 的 schema 驗證（同 LM 的契約測試做法：狀態碼在規格內、本文符合 schema、規格要求的標頭存在、`Error` 恰好是 `{error:{code,message,retryable}}` 且 code 在 enum 內）。再加一組「對真 LM 的冒煙測試」（只讀：`health`），在 CI 的 nightly 跑，捕捉契約漂移。

### 6.2 真機驗收劇本（正式 LM + 專用測試 OA + 測試客戶的 LINE）

前置：5.1–5.4 完成；測試 OA 已在 LM 登記並設好 webhook；IP staging 已登記為產品。每一步記錄「HTTP 狀態、`error.code`、時間」，**不記金鑰與碼**。

| # | 動作 | 預期 |
|---|---|---|
| 1 | `GET /health` | `200 {"ok":true}` |
| 2 | 攝影師（測試帳號）在 IP 按「連結 LINE」→ LIFF 登入 → 同意頁 | 同意頁顯示 IP 產品名、測試 OA、**回調主機名稱**；同意後回到 IP，`state` 驗證通過；`links/token` 成功，`bot_display_name` 正確；`GET /links/{id}` 為 `active` |
| 3 | **負向**：竄改 URL 中的 `state`（或用另一個瀏覽器／無 session 開回調連結） | IP 拒絕，不呼叫 `links/token`，顯示「請重新開始」；用過的 `code` 再用 → `INVALID_CODE`（需先在 IP 自己的流程驗證；LM 側用手動 curl 驗第二次換碼被拒） |
| 4 | **負向**：同意頁按「取消」 | 回調帶 `error=access_denied`，IP 顯示已取消、可重試 |
| 5 | 客戶頁要綁定碼；手機點 `bind_url`（或手動傳碼） | LINE 開啟並預填碼；傳出後 OA 回「已完成綁定，之後會在這裡通知你」；IP 輪詢到 `bound` |
| 6 | **負向**：`bind_url` 為 `null` 的 fallback（假伺服器或 IP 端強制走文字路徑） | 頁面顯示碼與步驟；手動傳碼仍可綁定 |
| 7 | 發通知（含按鈕、按鈕網址在登記網域內） | `200`；手機收到 Flex（標題粗體、內文、按鈕）；按鈕開得到 IP 頁 |
| 8 | 同鍵同內容再送 | `200` + `X-Idempotency-Replayed: true`、同一 `message_id`，手機**沒有**第二則 |
| 9 | **負向**：同鍵不同內容 | `422 IDEMPOTENCY_KEY_REUSE` |
| 10 | **負向**：`action.url` 不在登記網域；內文含 `https://` | `422 INVALID_URL_DOMAIN`；`400 INVALID_REQUEST`；手機都沒收到 |
| 11 | **負向**：未綁定的 ref | `409 CONTACT_NOT_BOUND`；IP 畫面顯示「客戶尚未綁定」 |
| 12 | 客戶封鎖 OA → 發通知；解除封鎖（重新加好友）→ 再發 | `409 RECIPIENT_BLOCKED`（狀態 `blocked`）；之後 LM 自動還原 `bound`，再發 `200`。`[未驗證]` 項目，務必留證 |
| 13 | **負向**：第二個 LINE 帳號用同一 ref 的預設碼 | 不覆蓋、OA 沉默、狀態仍 `bound`（`bound_at` 不變）；改用 `allow_rebind:true` 的新碼 → 覆蓋，`bound_at` 變新，**原帳號**收到「你的綁定已被更換」。`[未驗證]` 項目，務必留證 |
| 14 | **負向**：對同一客戶 1 小時內發第 11 則 | `429 RATE_LIMITED` 帶 `Retry-After`；IP 依秒數重試成功；手機沒有重複 |
| 15 | 輪替金鑰 | 新金鑰可用、舊金鑰 `401 INVALID_KEY`；IP 的 worker 重載後恢復 |
| 16 | 攝影師在 LM 後台撤銷連結 | 下一次發送 `403 LINK_REVOKED`；IP 停止送件、顯示「請重新連結」、待發通知保留；重新授權後恢復（被明確撤銷 → 客戶需重綁，IP 的畫面要能處理） |
| 17 | `DELETE /contacts/{ref}` 兩次 | 兩次都 `204`；狀態 `unbound`；再發通知 `409 CONTACT_NOT_BOUND` |
| 18 | 後端抓密：在 IP 的 log／錯誤追蹤搜尋 `brk_`、`bps_`、`lmc_`、`LM-` 樣式 | 無任何命中 |

### 6.3 與 LM-3E 的關係

`gap-analysis` 的 LM-3E 定義為「與另一個產品端對端；故障演練；`/security-review`」，相依 LM-3B 與對方的工單。狀態：LM 側的 `/security-review`（對抗式審查，`lm-3e-security-review.md`）**已完成**，Medium 三項（M-01～M-03）已修；E2E 與故障演練**尚未做**，需要 IP 側完成 IP-1…IP-4。LM 各階段的真機驗證多為「操作者回報、未逐項留證」，LM-3E 的自動化／有證據的 E2E 要把這些重驗（見 6.5）。

### 6.4 故障演練（至少）

| 情境 | 預期行為 |
|---|---|
| LM 回 `502`／`503`／逾時／非 JSON | 同鍵退避重送；不重複發送；超過上限進入待人工；不崩潰 |
| 回應遺失（LM 已送出，IP 沒收到 200） | 同鍵重送得到回放，客戶只收到一則 |
| IP 在「已送出」與「標記完成」之間崩潰 | 重啟後同鍵重送，不重複 |
| 同一事件並行兩個 worker 送同一把鍵 | 一個得到 `200`、另一個 `409 IN_PROGRESS` 或回放；客戶一則 |
| 預算耗盡（模擬 `402`） | 暫停、保留、恢復；不重試風暴 |
| `429` 大量（批次事件） | 依 `Retry-After` 平滑；不超過 60/分、10/小時/客戶 |
| 中途 `LINK_REVOKED` | 立即全面停止、保留待發、攝影師提示 |
| 金鑰輪替競態 | worker 重載金鑰後恢復，不告警洪水 |
| `links/token` 回應遺失 | 連結顯示失敗，重新授權可走通 |
| `state` 重放／過期／換瀏覽器回調 | 拒絕並引導重新開始 |
| callback 重複送出（使用者重新整理） | 第二次不再換碼、不顯示錯誤頁，導向連結狀態頁 |

### 6.5 出口條件（建議，Tim 確認）

1. 6.2 全部 18 步在正式 LM + 測試 OA 通過，且**每步留有證據**（狀態碼／code／時間／截圖），尤其是 `[未驗證]` 的第 12、13 步。
2. 6.4 故障演練全部通過。
3. IP 側 log／追蹤掃描無任何密鑰、綁定碼、LINE 識別資訊。
4. LM 側重驗過去「操作者回報」項目並留證：封鎖／解除封鎖還原、一般訊息與關鍵字回覆不受影響、第二帳號換綁、真實 D1 並行（重送、限流邊界、搶碼）、`bind_paused` 誤觸率。
5. 審查報告中尚未標示處理狀態的 Low 項目（L-02～L-12，其中 L-02 的綁定段已在 M-02 修正併成單一 batch）逐項決定：修、接受、或列入已知限制；多租戶開放前至少處理 L-07（保留政策）、L-08（全域密鑰退路）。
6. 契約凍結：`bridge-v1.yaml` 去掉 `draft`，G0 檢查表（見 Q13）勾完。

---

## 7. 已知限制與風險（誠實版）

**契約與行為**
- 200 只代表 LINE 受理；**沒有送達或已讀回報**，也沒有查詢端點。客戶可能因為封鎖、通知關閉、LINE 延遲而沒看到。
- 沒有對產品的事件推送；綁定與封鎖狀態只能輪詢或在發送失敗時得知。
- 只支援 1 對 1 聊天室綁定；客戶必須先加 OA 好友。
- LM 的 webhook 事件在背景處理，unfollow 與 follow 可能亂序，**狀態可能黏在 `blocked`**（審查 L-05）；任何一次 LINE 403 都會把「同一個 LINE 使用者在這個 OA 下所有連結」標成 blocked，且只有 follow 事件才能還原。產品要預期：`blocked` 可能是誤判，恢復途徑是客戶重新加好友、或重新綁定（同一個 LINE 使用者重綁自己視為成功，並把狀態設回 `bound`）。
- 綁定碼（`allow_rebind:false`）被靜默拒絕時，雙方都沒有訊號（OA 沉默、狀態不變）。
- **預算視窗是固定視窗**（UTC 對齊的分鐘、小時、日）：視窗邊界附近可短時間送出接近兩倍上限。
- 日預算與計數的原子性靠 D1 單句 UPSERT；`[未驗證]` 真實 D1 多區域下的並行語意（只用 Miniflare 的 SQLite 測過）。
- LINE API 呼叫沒有逾時（L-12）；月額度用盡靠比對 LINE 回應文字 `monthly limit`，文字改變會被當成可重試的 `RATE_LIMITED`（產品要有最大重試次數，別無限重試 429）。

**安全與隱私**
- `action.url` 網域白名單在登記時**不擋公共後綴**（L-04）；網域上的開放式轉址是產品責任。
- 內文只擋 `http(s)://`（L-03）：「請到 evil.com 登入」這類純文字釣魚擋不住；防線是攝影師可立即撤銷連結與稽核。
- 撤銷連結後 LM 仍保留 `contacts.line_user_id`（L-07），沒有自動清除（G0 提過的 30 天保留尚未實作）；`idempotency` 與 `audit_log` 也沒有清理。
- 綁定碼 60 bit、48 小時；以未加鹽 SHA-256 儲存（L-11）：D1 外洩時未過期的碼理論上可離線還原。
- 同意頁的 CSS 來自 CDN 沒有 SRI、沒有 CSP（I-03）。
- 認證之前的請求（假金鑰、`/health`、`/link/authorize`）沒有限流（L-09），每次都會打 D1；`links/token` 與 `bind-tokens` 的 KV 限流在 KV 缺失／出錯時 **fail-open**（既有行為）。
- 暫停機制可被用來阻斷某個 OA 的**新綁定**：每 bot 每分鐘 30 次「查無此碼」就暫停辨識 5 分鐘，不影響已綁定者與一般訊息。
- 綁定的「每 bot 查無此碼」預算採「先扣、查到碼再還」設計，在一分鐘內有 30 位以上真人同時綁定同一個 OA 時可能誤觸暫停（一般流量不會）。

**營運**
- 沒有產品密鑰輪替／停用 API；停用產品只能改 D1。
- `bind_url` 的預填連結、換綁通知是否送達、`bind_paused` 實際誤觸率，皆無真實環境證據。
- 同意頁的 LIFF 登入在手機上實測過參數保留；**桌機瀏覽器 + LINE 手機登入**的跨裝置情境未實測，可能導致回調落在沒有 IP session 的瀏覽器（`state` 驗證會拒絕，屬預期保護，但 UX 要處理，見 Q16）。
- LM 的各 plan 文件有過時段落（`lm-3a-plan` 本文仍寫 8 碼／7 天、`lm-3b-plan` §6 仍寫 KV 限流、`0003` 遷移檔註解寫 7 天）；以 `bridge-v1.yaml` 與程式為準。

---

## 8. 開放問題（需要 Tim 決定；每題附建議預設）

標「規格／程式不一致」者是核對時發現的。

| # | 問題 | 建議預設 |
|---|---|---|
| Q1 | **IP 側工單 0B、1C、2B、3C、3D 的定義不在本 repo**（`gap-analysis.md` 只有 LM 側）；第 4 節的清單是依契約推導，對照是推測。 | 接手 session 對照私有規格書修正編號；驗收條件以第 4 節為底線，只能加嚴不能放寬 |
| Q2 | **環境怎麼切**：IP 的 staging 要對哪個 LM？LM 有 dev（`pinti-line-dev` + `bridge-db-dev`）與 prod 兩套，dev 的網址與是否有可用的測試 OA 在 repo 內查不到。 | IP 開發期對假伺服器；整合測試對 prod LM + **獨立的 staging 產品登記** + **專用測試 OA**；上線時另登記 prod 產品。dev 環境是否開放給 IP 由 Tim 決定 |
| Q3 | **攝影師上線流程**：攝影師必須先成為 LM 使用者、在 LM 登記 OA（token + channel secret）、webhook 指向 LM，才能在同意頁選到 OA。是否就是預期的營運模式？由誰（IP 還是 LM）寫這份攝影師引導？ | 是；LM 提供一頁「連結前準備」文字，IP 在「連結 LINE」按鈕旁引用，並在同意頁回到 IP 時若 OA 列表為空，提示先完成 LM 設定 |
| Q4 | **回應沒有 `bot_id`**：`links/token` 只回 `link_id` 與 `bot_display_name`。IP 無法可靠偵測「兩個租戶連到同一個 OA」（後者會撤銷前者的金鑰，前者突然 `LINK_REVOKED`）。 | 不改規格；IP 以 `bot_display_name` 相同做警告，並把 `LINK_REVOKED` 的 UX 寫成「連結已中斷或被取代」。若多租戶共用 OA 是真實情境，請 Tim 評估在 `links/token` 回應加不透明的 `bot_ref` |
| Q5 | **每日預算 500 則是全域環境變數**（`BRIDGE_LINK_DAILY_CAP`），所有連結同一個數字；視窗是 **UTC 日**（台灣時間 08:00 重置）。規格只寫「每日」。IP 預期單一攝影師每日尖峰通知量是多少？是否可接受 08:00 重置？ | 先維持 500 / UTC；IP 提供尖峰估計（例如一次通知 600 位客戶就會爆）；需要時 Tim 調高全域值，之後再考慮 per-link 覆寫。請在規格註明視窗時區 |
| Q6 | **`QUOTA_EXCEEDED` 無法區分「每連結日預算」與「OA 月額度」**，兩者 retry 時機差很多。 | 不改規格；IP 一律「暫停＋每小時檢查＋攝影師提示」。若要精確，建議在 `Error` 加選填 `reason`（`daily_budget` / `monthly_quota`） |
| Q7 | **503 `bot_not_configured`**（OA 沒有可用 token，或 LINE 回 401）標 `retryable: true`，但不會自己好。 | IP 最多再試 3 次後提示攝影師檢查 LM 的 OA 設定；是否把 `retryable` 改為 `false` 由 Tim 決定 |
| Q8 | **冪等紀錄只保存 24 小時**（`IDEM_DONE_TTL_MS`），規格沒寫。同一把鍵過了 24 小時再送會被當新請求，**可能重複發送**。 | 在 `bridge-v1.yaml` 補一句；IP 的 outbox 超過 24 小時不自動重送 |
| Q9 | **（規格／程式落差）`GET /contacts/{ref}` 的 `pending` 語意**：程式在「已有綁定列」時永遠回 `bound`／`blocked`，即使有待用的換綁碼，所以換綁中看不到 `pending`；換綁被拒（預設）時 OA 沉默、狀態不變。規格沒有說明。 | 規格補註；IP 以 `bound_at` 變新判定換綁完成，並對「逾時未見變化」給客戶引導。需 Tim 確認這是預期設計 |
| Q10 | **（規格／程式落差）`event_type` 的用途**：規格說「僅用於稽核與去重」，但稽核 `detail` 白名單沒有它，去重只體現在冪等 fingerprint（同鍵不同 `event_type` → `IDEMPOTENCY_KEY_REUSE`）。 | IP 當成自由標籤，不依賴任何去重或稽核語意；規格措辭請修 |
| Q11 | **產品密鑰遺失／外洩怎麼辦**（沒有 API）。直接重登記會得到新的 `product_id`，既有連結屬於舊產品，等於所有租戶要重連。 | 先寫入營運手冊：Tim 以 D1 改 `secret_hash`（新密鑰須符合 `bps_<product_id 的 12 hex>_<43 字元>` 格式並計 SHA-256）；排入之後的小工單加輪替端點 |
| Q12 | **客戶如何驗證身分來看綁定碼**：綁定碼等同一次性密碼（3.2 第 8 條）。IP 現有客戶存取機制是否足以保證只有該客戶看得到？ | IP 在 IP-0 回答；若現況只是「知道連結就能看」，綁定碼要放在更強的憑證後面，或縮短在頁面上的顯示時間 |
| Q13 | **G0 檢查表仍未勾**（`gap-analysis` §8）：契約 `1.0.0-draft`，`title` 40／`body` 300 的長度「依 LINE 限制確認後再凍結」，及規格第 13 節三件事（額度用商家自己的 OA、綁定保留 30 天、未綁定時提示商家）尚未確認。 | IP 當作已凍結開發；Tim 在對接前完成 G0 並升版 `1.0.0`；之後變更走版本。綁定保留 30 天目前**未實作**（見 Q17） |
| Q14 | **（文件不一致）`BRIDGE_ENABLED` 的型別**：`lm-2a-plan` §15 寫 Secret，`gap-analysis` 寫 Variable（Text）。程式只比對字串 `1`，兩者都有效。 | Variable（Text） |
| Q15 | **（規格／程式落差，小）`GET /links/{id}` 的 `status: revoked`**：規格 `Link.status` 有 `revoked`，但撤銷後金鑰認證就失敗，永遠回 `403 LINK_REVOKED`，`200` 加 `revoked` 不會出現。 | 規格註明；IP 把 `403 LINK_REVOKED` 當唯一的撤銷訊號 |
| Q16 | **跨瀏覽器／跨裝置的回調**：攝影師若在桌機發起、LIFF 登入跳到手機的 LINE 內建瀏覽器，授權完成後回調落在沒有 IP session 的瀏覽器，`state` 驗證會失敗。實測只涵蓋手機。 | IP 的回調錯誤頁提供「回到原本的瀏覽器重新開始」說明；Tim 以桌機發起 + 手機 LINE 登入實測一次（6.2 第 2 步加做） |
| Q17 | **撤銷後保留與刪除**（L-07）：LM 撤銷連結後仍保留客戶的 LINE userId，沒有自動清除；攝影師若先在 LM 後台撤銷，IP 就無法再呼叫 `DELETE /contacts/{ref}` 刪除。客戶要求刪除怎麼辦？ | IP 在租戶離開／客戶刪除時主動先刪綁定；LM 提供手動 SQL（`DELETE FROM contacts WHERE link_id='…'`）給營運；多租戶開放前實作 30 天清除或後台刪除功能 |
| Q18 | **OA 端的雜訊**：OA 自己的自動回覆／關鍵字／歡迎訊息，與客戶傳碼那一刻的互動（例如客戶傳碼時被關鍵字回覆搶先）；客戶尚未加好友時預填連結的行為。皆無實測證據。 | 6.2 第 5 步在測試 OA 上同時開啟自動回覆再測一次；寫進攝影師引導（建議綁定期間不要用會攔截所有訊息的自動回覆） |
| Q19 | **同一 LINE 使用者可綁同連結的多個 ref**（例如家人共用帳號，程式允許）。IP 是否需要避免一個客戶的多個案件／家人 ref 混在一起？ | IP 一位客戶一個 ref，同客戶不同案件共用同一 ref（綁一次）；是否允許同一 LINE 綁多個 ref 由 IP 自行決定，LM 不阻止 |
| Q20 | **LM 回應中的錯誤形狀不一**：新端點用 `{error:{code,message,retryable}}`；`/health`、關閉時的 404、`handleBridge` 兜底的 500（`{"success":false,"error":"internal_error"}`）是舊形狀。 | IP 的 client 以 HTTP 狀態為主、`error.code` 為輔，容忍所有形狀 |

---

## 9. 附錄

### A. 錯誤碼總表

回應形狀：`{"error":{"code":"…","message":"…","retryable":true|false}}`。「可重試」欄是**程式預設值**（`worker_src/bridge/errors.js`；個別回應可覆寫，例如 502 的 `INTERNAL` 依來源）。重試一律用**同一把** `Idempotency-Key`（發送）。

| code | HTTP | 可重試 | 出現在 | 意義 | 產品端建議 |
|---|---|---|---|---|---|
| `INVALID_KEY` | 401 | 否 | 所有金鑰端點、`links/token` | 金鑰缺漏／錯誤／已輪替掉／是系統金鑰；`links/token` 時為產品密鑰錯或產品已停用。不區分不存在與已撤銷 | 重載金鑰重試一次；仍失敗 → 標記連結「需處理」並告警；不要洪水重試 |
| `LINK_REVOKED` | 403 | 否 | 所有連結端點 | 連結已撤銷／被取代，或產品被停用 | 停止該租戶全部呼叫、保留待發、提示攝影師重新連結（3.3 第 16 條）；不自動重新授權 |
| `SCOPE_DENIED` | 403 | 否 | 所有連結端點 | 金鑰 scope 不足 | 程式／連結設定錯誤；告警；檢查登記的 scopes 與 `links/token` 回傳 |
| `INVALID_CODE` | 400 | 否 | `links/token` | 授權碼過期／已用／不存在／`redirect_uri` 不符／屬別的產品 | 請攝影師重新發起授權 |
| `INVALID_REQUEST` | 400（超大本文 413；LINE 拒絕時 400） | 否 | 全部 | JSON 無效、欄位格式錯、含禁止內容（`http(s)://`）、`allow_rebind` 非 boolean、缺 `Idempotency-Key`、未知欄位、`state`／`redirect_uri` 不合（authorize）、本文 > 20000 字元（413） | 程式錯誤；修正後可用同一把鍵（驗證類不佔鍵）。若 `message` 為 `LINE rejected the message`（LINE 400，已被快取）→ 改內容並**換新鍵** |
| `CONTACT_NOT_BOUND` | 409 | 否（客戶綁定後可再試） | `POST /messages` | ref 沒有綁定（含別條連結的 ref、已解除） | 顯示「客戶尚未綁定」；備援管道；綁定完成後可重送 |
| `RECIPIENT_BLOCKED` | 409 | 否 | `POST /messages` | 客戶封鎖了 OA（含 LM 已記為 blocked 的，此時不打 LINE） | 本地標 blocked、備援管道；解除封鎖後 LM 自動還原 |
| `IN_PROGRESS` | 409 | **是** | `POST /messages` | 同鍵請求仍在處理（最長 2 分鐘） | 1–5 秒後同鍵重試，有上限 |
| `INVALID_URL_DOMAIN` | 422 | 否 | `POST /messages` | `action.url` 不符規則或不在登記網域 | 設定／程式錯誤；檢查 `url_domains` 登記；告警 |
| `IDEMPOTENCY_KEY_REUSE` | 422 | 否 | `POST /messages` | 同鍵但內容不同 | 鍵設計錯誤；內容有改就遞增 `revision` |
| `NOT_FOUND` | 404 | 否 | 連結、聯絡人、`/messages` 以外路徑 | 路徑／方法不存在、`link_id` 不屬於這把金鑰、路徑 ref 格式不合 | 程式錯誤 |
| `QUOTA_EXCEEDED` | 402 | 否（不帶 `Retry-After`） | `POST /messages` | 每連結日預算用盡，或 OA 當月 LINE 額度用盡（不可區分，Q6） | 暫停＋保留＋提示；每小時最多檢查一次；日預算在 UTC 日界重置 |
| `RATE_LIMITED` | 429 | **是** | `links/token`、`bind-tokens`、`/messages`、同意頁人主體端點 | 每連結每分鐘、每聯絡人每小時，或 LINE 端限流（帶 `Retry-After` 秒數，≥ 1）；`bind-tokens` 未用碼上限（**不帶** `Retry-After`，不會自己好） | 依 `Retry-After` + 抖動，同鍵重試；批次要平滑；`bind-tokens` 上限 → 提示重試過晚或聯絡 LM |
| `INTERNAL` | 500 / 502 / 503 | **是**（預設） | 全部 | 500 未預期錯誤；502 LINE 無法連線或 5xx；503 `bridge_not_configured`（資料庫未就緒）、`bot_not_configured`（OA 沒有可用 token / LINE 401）；逾時 | 指數退避重試（上限 5 次／15 分鐘）後轉人工；`bot_not_configured` 最多再試 3 次後提示攝影師（Q7） |

不在 enum 內的回應：`GET /health`、Bridge 關閉時的 `404`、兜底 `500 {"success":false,"error":"internal_error"}`（舊形狀）；邊緣層（Cloudflare）的非 JSON 錯誤頁。client 要容忍。

### B. 限流與預算數字總表

來源：`worker_src/bridge/{notify,links,contacts,binding,db}.js`。視窗皆為**固定視窗**，邊界對齊 UTC。

| 項目 | 限制 | 計數維度／視窗 | 超過時 | 機制 |
|---|---|---|---|---|
| 發通知：每連結 | 60 則 | 每分鐘 | `429 RATE_LIMITED` + `Retry-After`（距視窗結束秒數，≥ 1） | D1 原子計數 |
| 發通知：每聯絡人 | 10 則 | 每（連結, ref）每小時 | 同上 | D1 原子計數；鍵為 `sha256(ref)` 前 32 碼 |
| 發通知：每連結每日預算 | **500 則**（`BRIDGE_LINK_DAILY_CAP` 可調，全域） | 每連結每 **UTC 日**（台灣 08:00 重置） | `402 QUOTA_EXCEEDED`（不打 LINE） | D1 原子計數；達 80%（第 400 則）寫稽核 `usage_high`（每連結每日一次） |
| 要綁定碼：頻率 | 30 次 | 每連結每分鐘 | `429` + `Retry-After` | KV 固定視窗（KV 缺失／出錯時 fail-open） |
| 要綁定碼：有效未用碼 | 1000 | 每連結同時有效；同 ref 即將被取代的不計 | `429 RATE_LIMITED`，**無** `Retry-After` | D1 條件寫入（並行時可能短暫略超） |
| `links/token` | 30 次 | 每（來源 IP, product_id）每分鐘 | `429` + `Retry-After` | KV 固定視窗（fail-open） |
| 產品登記（營運） | 10 次 | 每 IP 每分鐘 | `429` | KV |
| 綁定嘗試（客戶傳碼，LM webhook 側） | 10 次 | 每（bot, LINE 使用者）每分鐘（只有「長得像綁定碼」的訊息計次） | 靜默（`handled:false`，OA 不回） | D1 原子計數 |
| 綁定嘗試：每 bot「查無此碼」 | 30 次 | 每 bot 每分鐘 | **暫停辨識該 bot 的綁定碼 5 分鐘**（稽核 `bind_paused`，每 bot 每小時一筆） | D1 原子計數（先扣、查到碼再還）+ `flags` |
| 冪等紀錄 | 完成後保存 **24 小時**；處理中 **120 秒** | 每（連結, 冪等鍵） | 同鍵：回放／`IN_PROGRESS`／`IDEMPOTENCY_KEY_REUSE` | D1 `idempotency` |
| 授權碼 | 5 分鐘、單次 | — | `INVALID_CODE` | D1 |
| 綁定碼 | 48 小時、單次（舊 8 碼過渡期內仍可用至各自過期） | — | 靜默 | D1 |
| `GET /contacts/*`、`DELETE /contacts/*`、`GET /links/*`、`rotate-key`、`DELETE /links/*` | **沒有限流** | — | — | `[已核對]` 但請自我節制（見 2.7） |
| OA 月額度 | 依該 OA 的 LINE 方案；每則訊息成本 1 | OA 每月 | `402 QUOTA_EXCEEDED` | 對帳 LINE 的 quota／consumption（失敗時沿用舊快取；完全沒資料就放行，由 LINE 擋） |

### C. 欄位限制總表

| 欄位／參數 | 限制 |
|---|---|
| `external_contact_ref` | `^[A-Za-z0-9_-]{8,64}$`；不得含個資（慣例，LM 無法檢查） |
| `allow_rebind` | boolean，預設 `false`；非 boolean → 400 |
| `event_type` | `^[a-z][a-z0-9_.]{0,63}$` |
| `title` | 1–40 code point；非全空白；無控制字元（含 U+0000–001F、U+007F–009F、U+2028、U+2029）；不含 `http://` `https://`（不分大小寫） |
| `body` | 1–300 code point；非全空白；僅允許 `\n` 一種控制字元；不含 `http://` `https://` |
| `action` | 選填；只有 `label`、`url`，皆必填 |
| `action.label` | 1–20 code point；非全空白；無控制字元；不含 `http(s)://` |
| `action.url` | ≤ 1000 字元（正規化後也要 ≤ 1000）；`https`、無帳號密碼、埠空或 443、非 IP／localhost／IPv6、無空白與控制字元、主機等於或為登記網域的子網域 |
| `Idempotency-Key`（`/messages`） | 必填，1–128 字元；標頭名稱**不帶** `X-`（`/raw/*` 才是 `X-Idempotency-Key`） |
| 請求本文大小 | `/messages`：> 20000 字元 → `413`；其餘端點：> 20000 字元視為無效 JSON → `400` |
| 未知欄位 | `/messages`（含 `action` 內）一律 `400`；`bind-tokens` 對未知欄位不報錯（只讀 `external_contact_ref`、`allow_rebind`） |
| `state`（authorize） | 1–256 字元 |
| `redirect_uri` | ≤ 2048 字元；與登記值逐字元相同 |
| `product_id` | `^prd_[a-f0-9]{12}$` |
| `link_id` | `^lnk_[a-f0-9]{16}$` |
| 授權碼 | `^lmc_[A-Za-z0-9_-]{43}$` |
| 產品密鑰 | `^bps_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$`（12 位 hex = product_id 的尾碼） |
| 連結金鑰 | `brk_<6 位小寫 hex>_<base64url 密鑰>`；認證只比對整把的 SHA-256，不要自己解析或假設長度 |
| 綁定碼 | `LM-` + 12 碼 `[0-9A-HJKMNP-TV-Z]`，顯示 `LM-XXXX-XXXX-XXXX` |
| `message_id` | `msg_` + 16 位小寫 hex |
| 登記：`name` | 1–100 字元 |
| 登記：`redirect_uris` | 1–10 個 |
| 登記：`url_domains` | 0–20 個，小寫主機名稱 |
| 通知訊息外觀 | Flex bubble；`altText` = 標題（≤ 400）；無圖片、無自訂顏色 |

### D. 標頭速查

| 端點 | 請求標頭 | 回應標頭 |
|---|---|---|
| `links/token` | `Authorization: Bearer <PRODUCT_SECRET>`、`Content-Type: application/json` | `Cache-Control: no-store` |
| 其他連結端點（`links/{id}`、`rotate-key`、`contacts/*`） | `Authorization: Bearer <LINK_KEY>`（**不需** `X-Bot-Id`） | `Cache-Control: no-store`；`429` 帶 `Retry-After` |
| `POST /messages` | `Authorization: Bearer <LINK_KEY>`、`Idempotency-Key`、`Content-Type: application/json` | `Cache-Control: no-store`；重送 `X-Idempotency-Replayed: true`；`429` 帶 `Retry-After` |
| `GET /link/authorize` | 無（瀏覽器導覽） | `302` + `Location`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer` |

### E. 來源索引

契約：`docs/integration/bridge-v1.yaml`。流程與營運：`lm-2a-plan.md`（連結、同意頁、產品登記、營運手冊 §14、真機手冊 §15）、`lm-3a-plan.md`（綁定）、`lm-3b-plan.md`（通知）、`lm-sec-plan.md`（M-01～M-03 修正：預算、綁定碼、覆蓋、`state` MUST）、`lm-3e-security-review.md`（已知與未驗證）、`gap-analysis.md`（取捨 D-1…D-7、LM 工單、G0 檢查表）、`ARCHITECTURE_PLATFORM.md`（資料歸屬原則，第十一節）。程式：`worker_src/bridge/{links,contacts,binding,notify,auth,errors,db,quota}.js`。
