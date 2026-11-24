# Bridge v1.1 契約草案(新增：postback 分流、事件轉發、LINE 身分換 ref、客人分眾)

- 狀態：**草案，全部 `planned`，沒有任何程式碼。** 2026-11-24。
- 依據：`adr-001-lm-product-boundary.md`
- 和 `bridge-v1.yaml` 的關係：v1.1 **只新增，不修改** v1 的任何端點、欄位或錯誤碼。路徑前綴仍是 `/bridge/v1`。每一項實作完成時，才把它的規格搬進 `bridge-v1.yaml`(契約測試會比對，所以未實作的端點不能先放進去)，同時把 `info.version` 升為 `1.1.0`。
- 標記：★ = 待 Tim 決定，附建議預設。

---

## 0. 共通

### 0.1 新增的 scope
| scope | 允許 | 何時取得 |
|---|---|---|
| `events:receive` | LM 把這條連結所屬 OA 上的 `px:<product_key>:` 事件轉給產品 | 產品登記時開放，攝影師在同意頁同意 |
| `identity:read` | 產品用一次性的身分碼換出 `external_contact_ref` | 同上 |
| `segments:write` | 產品替已綁定的客人設定分眾名稱(§D)，LM 依此切換他的 Rich Menu | 同上 |

既有的連結**不會自動取得**新 scope：同意頁要顯示新的權限，攝影師重新授權後才生效(換碼後舊連結被新連結取代；客人綁定的處理照 v1 規則)。

### 0.2 產品登記新增的欄位(`POST /bridge/v1/admin/products`，營運端點，不在產品契約內)
| 欄位 | 規則 |
|---|---|
| `product_key` | `^[a-z][a-z0-9]{1,15}$`，全域唯一，登記後不可改。用在 postback 前綴，例如 `ip` |
| `event_url` | 有 `events:receive` 時必填。https、不帶帳密或 fragment、主機名稱必須在 `url_domains` 內 |
| `identity_return_uris` | 有 `identity:read` 時必填。規則和 `redirect_uris` 相同(精確比對) |
| (回傳)`event_signing_secret` | `pes_` 開頭，**只在登記時出現一次**，供產品驗證 LM 送來事件的簽章。和 `product_secret` 分開 |

---

## A. postback 命名規則

### A.1 格式
LINE postback 的 `data` 上限為 300 字元。

| 前綴 | 誰處理 | 範例 |
|---|---|---|
| `lm:<action>[?query]` | LM 自己 | `lm:reply?key=hours`(回關鍵字回覆 `hours`)、`lm:menu?tab=wedding`(切換 Rich Menu 分頁) |
| `px:<product_key>:<action>[?query]` | 轉給該產品(§B) | `px:ip:plans`、`px:ip:status`、`px:ip:plans?type=wedding` |
| 沒有前綴 | 舊行為：`tag=`／`untag=` 自動標籤 | `tag=VIP` |

- `action`：`^[a-z][a-z0-9_.-]{0,31}$`。
- `query`：URL query 格式，最多 8 組，key `^[a-z][a-z0-9_]{0,15}$`，value ≤ 64 字元。
- 格式不合 → 不轉發、不回覆，只記稽核(原因碼)。

### A.2 LM 內部行為修正(不屬於產品契約，但和 A 一起做)
- **拿掉「✅ 已收到您的操作：<原始 data>」這句回覆**：它會把內部字串直接顯示給客人。沒有前綴、也不是標籤指令的 postback，改為不回覆。
- `lm:reply?key=` 對應到 LM 現有的關鍵字回覆內容(同一份設定，不另開新的資料表)。

---

## B. 事件轉發(同步回覆)

> **狀態：已實作(LM-4B)，規格已搬進 `bridge-v1.yaml` 的 `x-lm-events`(1.1.0)。** 產品登記帶 `product_key`、`event_url`，簽章密鑰 `event_signing_secret` 只在登記或輪替時回一次；既有產品用 `PATCH /bridge/v1/admin/products/{id}` 補。備用內容用 `/bridge/v1/admin/event-fallbacks` 或後台「已連結的產品」頁設定。

### B.1 何時轉發(全部條件都要成立)
1. 事件是 `postback`，`data` 符合 `px:<product_key>:…`；
2. 來源是 1 對 1 聊天(`source.type = user`)；
3. 這個 OA 上有一條 `active` 的連結，所屬產品的 `product_key` 相符、未停用，而且連結有 `events:receive`；
4. 沒有超過轉發限流(★ 每位 LINE 使用者每條連結每分鐘 10 次；超過就靜默略過，不回覆)；
5. 這個事件不是重複送達(依 LINE 的 `webhookEventId` 去重)。

條件不成立 → 不呼叫產品。第 3 項不成立而且這個動作有設定備用內容 → 回備用內容；否則不回覆。

### B.2 LM → 產品的請求
```
POST <event_url>
Content-Type: application/json
X-LM-Event-Id: evt_<32 hex>
X-LM-Timestamp: <unix 秒>
X-LM-Signature: v1=<hex(HMAC-SHA256(event_signing_secret, "<timestamp>.<raw body>"))>
```
```json
{
  "event_id": "evt_…",
  "type": "postback",
  "occurred_at": "2026-11-24T08:00:00Z",
  "link_id": "lnk_…",
  "action": "status",
  "params": { "type": "wedding" },
  "contact": { "external_contact_ref": "ipc_…", "status": "bound" }
}
```
- `contact`：這位 LINE 使用者在**這條連結**下已綁定時才有，否則為 `null`(公開查詢，例如方案)。
- **永遠不帶**：LINE userId、顯示名稱、頭像、replyToken、原始 `data` 字串。
- 產品必須：驗證簽章(常數時間比較)、拒絕和現在時間相差超過 300 秒的 `X-LM-Timestamp`、用 `event_id` 去重。

### B.3 產品的回應
| 回應 | LM 的處理 |
|---|---|
| `200` + `{"reply": Notification}` | 驗證通過就用 reply 送出 |
| `204` | 不回覆客人(產品刻意不回) |
| 其他狀態碼、非 JSON、驗證不過、逾時、連線錯誤 | 送出備用內容(§B.4) |

- `Notification` 沿用 v1 的 schema，**去掉** `external_contact_ref` 和 `event_type`：`{title ≤40, body ≤300, action?: {label ≤20, url}}`。驗證規則和 `POST /messages` 完全相同：文字內不能有 `http(s)://`、`action.url` 必須是 https 而且在 `url_domains` 內。外觀和 `/messages` 相同(同一個 Flex 範本)。
- 回應本文上限 4 KB。

### B.4 逾時與備用內容
- 逾時：★ **2500 毫秒**，由環境變數 `BRIDGE_EVENT_TIMEOUT_MS` 設定(合法範圍 500–5000，其他值一律用預設)。
- 逾時一到，LM **主動中止**對產品的請求，立刻送出備用內容。之後才到的產品回應**直接丟棄**，不會改用 push 補送。
- 備用內容：★ 在 LM 後台**依「OA × product_key × action」設定**(設定 Rich Menu 時一併設定)，格式和 B.3 的 `Notification` 相同，網址同樣受 `url_domains` 限制。沒有設定的動作使用通用文字「目前無法查詢，請稍後再試」，不帶按鈕。
- 備用內容**不能依客人而異**(LM 不知道產品的客人頁要帶什麼參數)。
- reply token 的有效時間以 LINE 官方文件為準，實作前要確認；2500 毫秒是預設值，依實測再調整。

### B.5 執行方式、額度與稽核
- LM 先回 LINE webhook `200`，轉發和 reply 在 `ctx.waitUntil` 裡完成。
- reply 不花 OA 的訊息額度，也**不計入**連結的每日預算(500 則)。
- 稽核記錄：`event_id`、`link_id`、`action`、結果(`replied`／`no_reply`／`fallback_timeout`／`fallback_error`／`fallback_invalid`／`not_forwarded`)、延遲毫秒數。不記 LINE userId、`params` 的值、回覆內容。

---

## C. LINE 身分換 ref

### C.1 流程
```
客人在 Rich Menu 按「我的相片」(網址按鈕)
  → https://liff.line.me/<該 OA 的 LIFF ID(LM 自動建立，§C.4)>/bridge/identity?p=<product_key>&to=<路徑>
  → LM 的 LIFF 頁取得 ID token，送給 LM 後端
  → LM 向 LINE 驗證 ID token，得到 userId
  → LM 找這個 OA 上 product_key 對應、有 identity:read 的 active 連結
  → LM 產生一次性身分碼 lmi_…(60 秒、只能用一次，只存雜湊)
  → 302 到產品登記的 identity_return_uri?code=lmi_…&to=<路徑>
產品後端：
  POST /bridge/v1/identity/token  (Authorization: Bearer <連結金鑰>)
  {"code": "lmi_…"}
  → 200 {"link_id", "contact": {"external_contact_ref", "status"} | null}
產品用 ref 找到自己的客人，建立產品自己的短效 session。
```

### C.2 規則
- 身分碼的處理比照 v1 的授權碼(`lmc_`)：60 秒、單次使用、只存雜湊；第二次使用或過期 → `400 INVALID_CODE`。重用 v1 的錯誤碼，不新增。
- 身分碼必須用「發碼那條連結」的金鑰兌換，用其他連結的金鑰 → `INVALID_CODE`。
- `contact = null`：這個 LINE 帳號在這條連結下沒有綁定。產品應該引導客人先綁定，不要自己猜是誰。
- `to`：產品自己的相對路徑(`^/[A-Za-z0-9/_\-.?=&]{0,199}$`)，LM 原樣帶回、不解讀。產品要再驗證一次，避免開放轉址。
- 產品回調頁要設 `Referrer-Policy: no-referrer`，換完碼後立即導向不含 `code` 的網址(和 v1 授權碼的 MUST 相同)。
- LM 不回傳也不記錄 userId；稽核只記 `link_id`、結果、時間。

### C.3 平台限制(重要)
LINE userId 是**依 Provider 區分**的：同一個人在不同 Provider 底下的 userId 不同。綁定時 LM 存的是「OA 所屬 Provider」底下的 userId，所以 **LIFF 必須和該 OA 在同一個 Provider 底下**，換出來的身分才對得上。見 Q1 與 C.4。

### C.4 LIFF 的建立：攝影師只建 channel，LIFF 由 LM 自動建立
LIFF App 只能掛在 **LINE Login channel**(或 LINE MINI App channel)底下，不能掛在 Messaging API channel。LINE Login channel **沒有建立用的 API**，但 LIFF App 有(LIFF Server API)。分工如下：

| 步驟 | 誰做 | 方式 |
|---|---|---|
| 1. 在 OA 所屬的 Provider 底下建立 LINE Login channel | **攝影師，手動一次** | LINE Developers Console；LM 提供圖文教學 |
| 2. 把 channel ID、channel secret 填進 LM(依 OA 設定) | **攝影師** | LM 後台的 OA 設定頁，和現在填 OA 的 channel secret、token 同一處 |
| 3. 用 channel ID＋secret 取得 LINE Login channel 的 access token | LM，自動 | LINE 的 channel access token API |
| 4. 建立 LIFF App(endpoint = LM 的 `/bridge/identity` 頁，scope `openid`) | LM，自動 | `POST https://api.line.me/liff/v1/apps` |
| 5. 存下 LIFF ID；設定 Rich Menu 的「我的相片」按鈕時自動帶入 LIFF 網址 | LM，自動 | — |

規則：
- **Provider 驗證**：LIFF 建好後，LM 要確認這個 LINE Login channel 和 OA 屬於同一個 Provider，否則不啟用 C。實作前要先確認 LINE 有沒有提供可靠的判斷方式；沒有的話，改用「攝影師本人在 LIFF 登入一次，比對他在 OA 的 userId」來驗證，或改為人工確認。
- **密鑰保存**：LINE Login 的 channel secret 是新的密鑰，比照 OA token 加密保存；不進回應、log 或稽核。
- **冪等**：重新執行步驟 3–5 時，已經有 LM 建立的 LIFF 就沿用(依 endpoint 比對)，不重複建立。攝影師換掉 channel 時，舊的 LIFF ID 失效、重新建立。
- **失敗處理**：步驟 3–4 失敗時(secret 錯誤、channel 不是 LINE Login 類型、LIFF 數量達上限)，在 LM 後台顯示可行動的錯誤訊息；這個 OA 的 C 功能維持關閉，其他功能不受影響。
- **未驗證**：上表依目前對 LINE API 的了解所寫，**沒有查證最新文件，也沒有實測**。實作前先查 LINE 官方文件，確認 API、所需權限與 LIFF 數量上限。

---

## D. 客人分眾(產品決定「誰是 VIP」，LM 決定「VIP 看哪個 Rich Menu」)

> **狀態：已實作(LM-4D)，規格已搬進 `bridge-v1.yaml`(1.1.0)。** 產品的 `product_key` 由營運端點 `PATCH /bridge/v1/admin/products/{id}` 補上(只能設一次)。

### D.1 為什麼
「誰是 VIP」是業務判斷(拍過幾次、訂過相本……)，依 ADR 歸產品；「VIP 看到哪一版 Rich Menu」是 OA 設定，歸 LM。產品只告訴 LM 分眾名稱，**不知道** Rich Menu 的 id；LM **不知道**分眾的判定規則。

### D.2 端點
```
PUT /bridge/v1/contacts/{external_contact_ref}/segment
Authorization: Bearer <連結金鑰>          (需要 segments:write)
{"segment": "vip"}                        (或 {"segment": null} 清除)
→ 204
```
- `segment`：`^[a-z][a-z0-9_-]{0,31}$` 或 `null`。每位客人在每條連結下**最多一個**分眾(要多層就用不同名稱，例如 `vip`、`vip_gold`)。
- 冪等：同樣的值再送一次也是 `204`，不會重複觸發 LINE API。
- 只對 `bound` 的客人有效：否則 `409 CONTACT_NOT_BOUND`(`blocked` 回 `409 RECIPIENT_BLOCKED`)。不存在的 ref 一樣回 `409 CONTACT_NOT_BOUND`，不洩漏是否存在。
- 限流：每條連結每分鐘 60 次(和發送分開計)；超過回 `429 RATE_LIMITED`。
- 回應與稽核都不含 LINE userId、Rich Menu id。
- **新增欄位(只增不改)**：`GET /contacts/{ref}` 的回應多一個 `segment`(字串或 `null`)。

### D.3 LM 這邊怎麼套用
- LM 後台設定對應表：**OA × product_key × segment → Rich Menu**。沒有對應的分眾 = 不影響 Rich Menu。
- 套用時機：分眾改變時、客人綁定或重新綁定時。
- 清除時機：客人解除綁定、封鎖 OA、連結撤銷或被取代時，LM 把這位客人的分眾清掉並重新計算 Rich Menu。
- 和 LM 自己的標籤規則**共用同一份優先順序**(見 `lm-4-plan.md` 的 LM-4R)：例如 `owner` 標籤 > `photographer` 標籤 > `ip:vip` 分眾 > 預設選單。
- 切換 Rich Menu 呼叫 LINE API 失敗時，LM 自行重試；產品的 `PUT` 不因此失敗(分眾已記錄)。

### D.4 不做
- 不提供「列出某分眾的所有客人」(那是產品的 CRM)。
- 不用分眾做群發(對特定客人群發走 `/messages`，見產品端設計)。
- **Rich Menu 不是權限控管**：VIP 專屬內容，產品在自己那邊必須再檢查一次。

## E. 錯誤碼

不新增錯誤碼。`/contacts/{ref}/segment` 使用 v1 既有的 `INVALID_KEY`、`LINK_REVOKED`、`SCOPE_DENIED`、`INVALID_REQUEST`、`CONTACT_NOT_BOUND`、`RECIPIENT_BLOCKED`、`RATE_LIMITED`、`INTERNAL`。`/identity/token` 使用 v1 既有的 `INVALID_KEY`、`LINK_REVOKED`、`SCOPE_DENIED`、`INVALID_CODE`、`INVALID_REQUEST`、`RATE_LIMITED`、`INTERNAL`。事件轉發是 LM 呼叫產品，產品不需要處理 LM 的錯誤碼。

## F. 產品端 MUST(新增部分)

1. 驗證事件簽章與時間戳，用 `event_id` 去重；`event_signing_secret` 和其他密鑰一樣只存在伺服器端。
2. 事件處理要快：只做查詢、不做重活，目標 p95 < 1 秒；做不完就回 `204`，或回一個連到頁面的按鈕。
3. `contact` 為 `null` 時只能回公開內容，不能回任何客人資料。
4. 回覆文字只放該客人本來就能看到的資訊(同 v1 §3.4)。
5. 身分碼只在伺服器端兌換；產品自己的 session 要短效，不能把 ref 放進前端。

## G. 測試計畫(實作時)

- LM：A 的格式解析(合法、超長、壞格式)；B 的轉發條件逐條、簽章、逾時中止、晚到回應丟棄、`204`、驗證失敗改送備用內容、去重、限流、稽核不含個資；C 的發碼與兌換、單次使用、過期、跨連結使用、連結撤銷、`contact = null`。
- 契約測試：每一項實作完成後搬進 `bridge-v1.yaml`，讓 `test_bridge_contract_*` 涵蓋。
- LM：D 的冪等、未綁定／封鎖、解除綁定時清除、優先順序計算、LINE API 失敗重試、回應不含 Rich Menu id。
- 產品：假 LM 伺服器新增「送事件」(帶正確或錯誤簽章)、「身分碼兌換」與「設定分眾」。
- 安全審查：B 和 C 各做一次(對外呼叫、身分)；D 併入 B 的審查。

## H. 開放問題(★ 附建議預設)

| # | 問題 | 建議 |
|---|---|---|
| Q1 | LIFF 和 OA 的 Provider 必須相同(§C.3)。其他攝影師的 OA 在他們自己的 Provider 底下 | 依 §C.4：**攝影師只在自己 OA 的 Provider 底下建一個 LINE Login channel，並填入 channel ID 和 secret；LIFF 由 LM 自動建立。** Tim 的 OA 先做；多租戶時這一步列入攝影師的上線教學 |
| Q2 | 備用內容設定在哪 | LM 後台，依 OA × product_key × action 設定 |
| Q3 | 逾時秒數 | 2500 毫秒，可用環境變數調整 |
| Q4 | 轉發限流 | 每位 LINE 使用者、每條連結每分鐘 10 次 |
| Q5 | 回覆格式 | 只開放 `Notification`(文字＋最多一顆按鈕)；需要圖片的內容用網址按鈕開網頁 |
| Q6 | 一個 OA 上有多個產品 | 由 `product_key` 分流；每個產品各自需要一條 active 連結 |
| Q7 | 沒有前綴的 postback | 保留 `tag=`／`untag=`，拿掉原始字串回覆(A.2) |
| Q8 | 分眾可以有幾個 | 每位客人每條連結一個；名稱由產品定 |
| Q9 | LM 的「會員等級」(`tier`)也會切換 Rich Menu，和標籤規則互相覆蓋 | 統一由標籤規則(含產品分眾)決定 Rich Menu；`tier` 不再綁 Rich Menu(LM-4R) |
