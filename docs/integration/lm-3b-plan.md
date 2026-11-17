# LM-3B 設計：受限 `/messages`（產品對已綁定客戶發通知）

狀態：設計，尚未實作。前置：LM-3A（聯絡人綁定）已上線並真機驗證（封鎖／還原與關鍵字回覆除外，見 lm-3a-plan §14）。
規格來源：`bridge-v1.yaml` 的 `POST /bridge/v1/messages` 與 `Notification`、`MessageResult`。

## 1. 目標與不做的事

目標：產品（連結金鑰 + `messages:send`）用 `external_contact_ref` 指定一位**已綁定**的客戶，送出一則受限格式的通知
（純文字標題、內文、最多一個按鈕）。LM 負責：格式驗證、網域白名單、把 ref 解析成 LINE userId（永不外洩）、
冪等、額度與封鎖處理、稽核。

不做：任意 LINE message object（那是 `/raw/*`，只給系統金鑰）、圖片上傳、群發、排程、範本、送達回報（outbound webhook）、
後台頁面。**沒有資料庫遷移**：用既有的 `idempotency`、`contacts`、`audit_log`。

## 2. 端點

`POST /bridge/v1/messages` — 連結金鑰、scope `messages:send`；系統金鑰一律拒絕（同其他連結端點）。
Header 必填 `Idempotency-Key`（≤128 字元；缺少 → `INVALID_REQUEST`）。

請求（`additionalProperties: false`）：
| 欄位 | 規則 |
|---|---|
| `external_contact_ref` | `^[A-Za-z0-9_-]{8,64}$`；只在**這條連結**範圍內解析 |
| `event_type` | `^[a-z][a-z0-9_.]{0,63}$`；只用於稽核與去重，不顯示給客戶 |
| `title` | 純文字，1–40 字元，不可含控制字元 |
| `body` | 純文字，1–300 字元，不可含控制字元（換行允許） |
| `action`（選填） | `{label ≤20, url}`，見 §4 |

回應 200：`{message_id, status:"sent", sent_at}`。`message_id` 是 LM 產生的關聯代號（`msg_` + 隨機），
只用於對帳與稽核，沒有查詢端點。（規格原寫 202 `accepted`；因為我們同步送出，改成 200 `sent`，見 §10。）

## 3. 送給客戶的訊息：由 LM 組裝

產品**不能**帶 LINE message object。LM 把欄位放進固定的 Flex bubble：標題（粗體）、內文、（有 `action` 時）一顆按鈕，
`altText` = 標題。所有文字都放進 Flex 的 `text` 欄位（LINE 不解析為標記），`action` 只會產生一個 `uri` action。
LM 不替換變數、不套用商家的關鍵字或會員資料。

## 4. `action.url` 白名單

以產品登記的 `url_domains` 為準。通過條件（全部成立）：
- `https:`、無帳號密碼、無 fragment 以外的怪東西；長度 ≤ 1000（LINE 上限）、無控制字元與空白。
- 主機名稱正規化（小寫、去尾端點）後，**等於**某個登記網域，或是它的**子網域**（`a.picker.example.com` 屬於 `picker.example.com`）。
- 不接受 IP 位址、`localhost`、埠號非 443。
- 不符 → `INVALID_URL_DOMAIN`（422）。
`title`／`body` 內**不得出現 `http://`、`https://`**（不分大小寫）；否則白名單可以靠把連結貼進內文繞過。
→ `INVALID_REQUEST`（400）。

## 5. 流程與錯誤對映

1. 認證（`withLink`, `messages:send`）→ 每連結限流 → 驗證 body → 驗證白名單。
2. 搶佔冪等：`idempotency` 的 `(bot_id, system, key_hash)`，**`system` 欄放 `link:{link_id}`** —— 同一連結內同一把鍵才算同一件事，
   不同連結（即使同產品、同 bot）互不影響，也不會撞到系統金鑰的紀錄。已完成且內容相同 → 回第一次結果並帶
   `X-Idempotency-Replayed: true`；內容不同 → `IDEMPOTENCY_KEY_REUSE`（422）；處理中 → `IN_PROGRESS`（409）。
3. 解析聯絡人：無綁定 → `CONTACT_NOT_BOUND`（409）；`status = blocked` → `RECIPIENT_BLOCKED`（409），**不打 LINE**。
   連結已撤銷／產品停用在認證階段已被擋（`LINK_REVOKED`）。
4. 額度：沿用 `bridge/quota.js`（以 LINE 的數字為準）；用盡 → `QUOTA_EXCEEDED`（402）。每則訊息成本 1。
5. 送出：`pushMessage`，帶 `X-Line-Retry-Key`（由 `bot|link|冪等鍵` 衍生的 UUID，第二道防線）。
   - LINE 409（retry key 已受理）→ 視為成功。
   - LINE 403（被封鎖）→ `RECIPIENT_BLOCKED`，同時把該 LINE 使用者的聯絡人標成 `blocked`、會員標成 inactive。
   - LINE 429 月額度 → `QUOTA_EXCEEDED`；其他 429 → `RATE_LIMITED`（帶 `Retry-After`）。
   - LINE 400 → `INVALID_REQUEST`；LINE 401／無 token → 503；網路層失敗或 5xx → `INTERNAL`（`retryable: true`）。
6. 冪等收尾：**成功**與**確定性失敗**才寫入第一次結果；`CONTACT_NOT_BOUND`、`RECIPIENT_BLOCKED`、額度、暫時性錯誤**不快取**
   （客戶之後可能完成綁定或解除封鎖，同一把鍵重試應該重新判斷）。這與 `/raw` 不同（`/raw` 會快取封鎖結果）。
7. 稽核：`message_sent`／`message_blocked`／`message_failed`，`detail` 只有 `product_id`、`link_id`、`message_id`、
   `error_code`、數量。**不記 ref、LINE userId、標題與內文。**

## 6. 濫用與成本控制

這是產品可以替商家對客戶發訊息的功能，風險是騷擾、詐騙連結與燒光商家額度。控制手段：
- **每連結限流**：預設每分鐘 60 則（KV 固定視窗；缺 KV 時 fail-open 是既有行為）。
- **每聯絡人頻率上限**：預設每小時 10 則（以連結 + ref 計）。超過 → `RATE_LIMITED`。
- 白名單與「內文禁止連結」（§4）；一個產品最多只能導向它自己登記的網域。
- 額度用的是商家自己的 OA；用盡時 LM 停止送出，不會超額。
- 稽核可追到每一則（誰、哪條連結、什麼結果），商家可在後台撤銷連結（立即停止）。

## 7. 資料隔離與隱私

- `external_contact_ref` → LINE userId 的解析只在 `bridge/db.js` 的專用函式內做，回傳值只在 handler 內存活，
  不進回應、audit、log；`bridge/messages` 風格的 `console.error` 只記 `err.message`。
- 跨連結的 ref 解析不到（`CONTACT_NOT_BOUND`，不洩漏他人是否存在）。
- 規格要求同一把鍵配不同內容回 `IDEMPOTENCY_KEY_REUSE`：fingerprint 用 `ref + event_type + title + body + action`。

## 8. 需要你確認的事（預設答案在括號）

1. **回應狀態碼**：同步送出，改成 `200 {status:"sent"}`，不用規格原寫的 202。（同意）
2. **`title`／`body` 禁止出現 `http(s)://`**，連結只能放在按鈕。（同意）
3. **網域比對**：登記網域本身與其子網域都算（`a.example.com` 屬於 `example.com`）。（同意；要更嚴格可改成只允許精確比對）
4. **`CONTACT_NOT_BOUND`、`RECIPIENT_BLOCKED` 不快取**（與 `/raw` 不同）。（同意）
5. **限流預設值**：每連結 60 則／分鐘、每聯絡人 10 則／小時。（同意；要調整直接給數字）
6. **訊息外觀**：Flex bubble（標題粗體 + 內文 + 一顆按鈕），不可自訂顏色、圖片。（同意）
7. **沒有訊息查詢端點與送達回報**；產品只能靠這次呼叫的結果。（同意；之後需要再加）

## 9. 工作切分

- **3B-1 後端**：`bridge/notify.js`（端點、驗證、組裝、白名單、對映）、`bridge/db.js` 新增解析聯絡人與標記封鎖的函式、
  `bridge/routes.js`／`index.js` 分派、`sanitizeDetail` 加 `message_id`、必要時把 `messages.js` 的重試鍵與錯誤對映抽成共用（**不改 `/raw` 行為**）、
  單元與 Miniflare D1 測試、邊界測試。
- **3B-2 真機實測**：同 3A，用暫時測試頁對你已綁定的聯絡人發一則通知（含按鈕、重送冪等、白名單負向、封鎖）。
- 上線：**無遷移**；合併部署後旗標關閉時行為不變。

## 10. 規格變動

`bridge-v1.yaml`：`POST /messages` 回應改 200 與 `status: sent`；錯誤列表不變；補上 `Retry-After`（429）；`x-status` 改 implemented。
`ARCHITECTURE_PLATFORM.md`：標記受限通知已實作。

## 11. 測試策略

- 格式：欄位長度、控制字元、`additionalProperties`、`event_type` 格式、缺冪等鍵。
- 白名單：精確網域、子網域、`evil-example.com`、`example.com.evil.com`、`http:`、帶帳號密碼、IP、`localhost`、非 443 埠、含空白／控制字元、過長。
- 內文含 `http://`／`HTTPS://` → 400。
- 解析：已綁定／未綁定／blocked／別條連結的 ref／連結撤銷／產品停用。
- 冪等：重送回第一次結果＋ header；不同內容 422；並行 8 個只送出 1 則（LINE 只被呼叫一次）；失敗類結果可重試。
- LINE 錯誤對映（409／403／429 月額度／429 其他／400／401／5xx／網路）。
- 額度用盡不打 LINE；成功後記用量。
- 限流：每連結、每聯絡人（時間釘在視窗中段，避免跨分鐘偶發失敗）。
- 稽核與回應不含 ref、userId、標題、內文（掃描斷言）；系統金鑰打 `/messages` 被拒；連結金鑰打 `/raw` 仍被拒。
- Flex 內容快照：只有預期欄位、`altText` 正確、按鈕 URI 即為白名單內的網址。
