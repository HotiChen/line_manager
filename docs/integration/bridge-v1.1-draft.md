# Bridge v1.1 契約草案(新增：postback 分流、事件轉發、LINE 身分換 ref)

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
  → https://liff.line.me/<該 OA 的 LIFF ID>/bridge/identity?p=<product_key>&to=<路徑>
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
LINE userId 是**依 Provider 區分**的：同一個人在不同 Provider 底下的 userId 不同。綁定時 LM 存的是「OA 所屬 Provider」底下的 userId，所以 **LIFF 必須和該 OA 在同一個 Provider 底下**，換出來的身分才對得上。見 Q1。

---

## D. 錯誤碼

不新增錯誤碼。`/identity/token` 使用 v1 既有的 `INVALID_KEY`、`LINK_REVOKED`、`SCOPE_DENIED`、`INVALID_CODE`、`INVALID_REQUEST`、`RATE_LIMITED`、`INTERNAL`。事件轉發是 LM 呼叫產品，產品不需要處理 LM 的錯誤碼。

## E. 產品端 MUST(新增部分)

1. 驗證事件簽章與時間戳，用 `event_id` 去重；`event_signing_secret` 和其他密鑰一樣只存在伺服器端。
2. 事件處理要快：只做查詢、不做重活，目標 p95 < 1 秒；做不完就回 `204`，或回一個連到頁面的按鈕。
3. `contact` 為 `null` 時只能回公開內容，不能回任何客人資料。
4. 回覆文字只放該客人本來就能看到的資訊(同 v1 §3.4)。
5. 身分碼只在伺服器端兌換；產品自己的 session 要短效，不能把 ref 放進前端。

## F. 測試計畫(實作時)

- LM：A 的格式解析(合法、超長、壞格式)；B 的轉發條件逐條、簽章、逾時中止、晚到回應丟棄、`204`、驗證失敗改送備用內容、去重、限流、稽核不含個資；C 的發碼與兌換、單次使用、過期、跨連結使用、連結撤銷、`contact = null`。
- 契約測試：每一項實作完成後搬進 `bridge-v1.yaml`，讓 `test_bridge_contract_*` 涵蓋。
- 產品：假 LM 伺服器新增「送事件」(帶正確或錯誤簽章)與「身分碼兌換」。
- 安全審查：B 和 C 各做一次(對外呼叫、身分)。

## G. 開放問題(★ 附建議預設)

| # | 問題 | 建議 |
|---|---|---|
| Q1 | LIFF 和 OA 的 Provider 必須相同(§C.3)。其他攝影師的 OA 在他們自己的 Provider 底下 | v1.1 的 C **只支援 LIFF 和 OA 同一個 Provider 的情況**：每個 OA 在 LM 登記自己的 LIFF ID(攝影師在自己的 Provider 建 LINE Login channel 與 LIFF)。Tim 的 OA 先做；多租戶時再評估操作成本 |
| Q2 | 備用內容設定在哪 | LM 後台，依 OA × product_key × action 設定 |
| Q3 | 逾時秒數 | 2500 毫秒，可用環境變數調整 |
| Q4 | 轉發限流 | 每位 LINE 使用者、每條連結每分鐘 10 次 |
| Q5 | 回覆格式 | 只開放 `Notification`(文字＋最多一顆按鈕)；需要圖片的內容用網址按鈕開網頁 |
| Q6 | 一個 OA 上有多個產品 | 由 `product_key` 分流；每個產品各自需要一條 active 連結 |
| Q7 | 沒有前綴的 postback | 保留 `tag=`／`untag=`，拿掉原始字串回覆(A.2) |
