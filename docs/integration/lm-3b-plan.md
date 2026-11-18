# LM-3B 設計：受限 `/messages`（產品對已綁定客戶發通知）

狀態：3B-1（後端）已實作，見 §12；3B-2（真機實測）待做。前置：LM-3A（聯絡人綁定）已上線並真機驗證（封鎖／還原與關鍵字回覆除外，見 lm-3a-plan §14）。
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

## 12. 實作與設計的對照（3B-1 實作時的決定）

### 12.1 §8 七個問題的決定（全部採預設答案）

1. 回應 `200 {message_id, status:"sent", sent_at}`；不用 202。
2. `title`／`body`（以及 `action.label`）不可含 `http://`、`https://`（不分大小寫）→ `INVALID_REQUEST`（400）。
3. 登記網域本身與其子網域都算；比對前主機名稱轉小寫、去一個尾端點；`evil-example.com`、`example.com.evil.com` 不通過。
4. `CONTACT_NOT_BOUND`、`RECIPIENT_BLOCKED` 不快取（釋放冪等鍵，同一把鍵之後可重判）。
5. 限流：每連結 60 則／分鐘、每（連結, ref）10 則／小時。
6. 固定 Flex bubble 外觀，不可自訂顏色、圖片。
7. 沒有查詢端點與送達回報（`GET /messages/{message_id}` 在規格中保留為 planned）。

### 12.2 與設計文字不同或設計沒寫死的地方

- **`line_user_id` 的讀取**：3A 的邊界測試規定 `db.js` 沒有任何 SELECT 讀出 `line_user_id`。送訊息必須讀它，所以新增 `getContactForSend`
  （全檔唯一一句，查詢同時以 `link_id`、`external_contact_ref`、`bot_id` 限定），並把邊界測試改成「恰好只有這一句、且只有 `notify.js` 使用」。
  這是把「完全沒有」收斂成「唯一一個例外」，不是刪除測試。回傳值只在 handler 內存活。
- **聯絡人查詢多比對 `bot_id`**：綁定列的 `bot_id` 與連結的 bot 不同時視為未綁定（防禦性，正常資料不會發生）。
- **產品網域**：用既有 `getProduct`（`url_domains` 已在其回傳值），沒有新增查詢；只在有 `action` 時才查。
- **retry key 抽成 `bridge/retry_key.js`**：從 `messages.js` 原樣搬出，`/raw` 的衍生值不變（既有測試未動）。
  通知的 `system` 參數是 `link:{link_id}`，所以衍生輸入是 `bot|link:{link_id}|冪等鍵`。
- **標頭名稱**：通知用規格的 `Idempotency-Key`；`/raw` 沿用 `X-Idempotency-Key`。通知端點不接受後者。
- **驗證順序**：認證 → 每連結限流（先於驗證計數，所以格式錯誤的請求也會消耗額度）→ `Idempotency-Key` → 本文 → 白名單 → 每聯絡人限流 → 冪等搶佔 → 聯絡人 → 額度 → 送出。
  被限流的請求沒有搶佔冪等鍵；但重送（回放）也會消耗每聯絡人的小時額度，因為限流在冪等之前。
- **額外驗證**：`title`／`body`／`label` 不可全是空白；`body` 只允許 `\n`（不允許 `\r`）；U+2028／U+2029 與 C1 控制字元也視為控制字元；
  長度以 code point 計。本文上限 20000 字元，超過回 413 `INVALID_REQUEST`（其他錯誤碼表沒有 413 專用碼）。
- **URL 正規化**：送給 LINE 的是 `new URL(...).href`（驗證過的那一個字串），不是原始輸入；正規化後長度也必須 ≤ 1000。
  任何主機名稱最後一段全為數字（含 `0x7f.1`、`2130706433` 這類會被正規化成 IP 的寫法）、IPv6 一律拒絕，即使登記了也一樣。
- **錯誤狀態碼**：LINE 5xx／網路錯誤／其他非預期狀態 → 502 `INTERNAL`（`retryable` 依是否 5xx／網路；設計只寫 `INTERNAL`，狀態碼仿 `/raw` 的 502）；
  無 token 與 LINE 401 → 503 `INTERNAL`（訊息 `bot_not_configured`）；資料庫不可用 → 503（訊息 `bridge_not_configured`，同 `links.js`）。
- **確定性失敗的範圍**：搶佔冪等鍵之後，只有 LINE 400 算確定性失敗而快取（訊息固定為 `LINE rejected the message`，不轉述 LINE 的內容）。
  其餘（未綁定、封鎖、額度、LINE 429、5xx、網路、無 token）都釋放。驗證類錯誤發生在搶佔之前，不涉及冪等。
- **LINE 409 視為成功**時不記用量（`/raw` 同樣的作法）；快取的是新產生的 `message_id`。
- **稽核**：`message_sent`（result `ok`）、`message_blocked`（`CONTACT_NOT_BOUND`、`RECIPIENT_BLOCKED`、`INVALID_URL_DOMAIN`，result `blocked`）、
  `message_failed`（其餘，result `failed`）；`detail` 只有 `product_id`、`link_id`、`message_id`（僅成功）、`error_code`、`status`、`cost`。
  `sanitizeDetail` 只新增 `message_id`（`^msg_[0-9a-f]{16}$`）。回放與驗證失敗（400／IDEMPOTENCY_KEY_REUSE／IN_PROGRESS／被限流）不寫稽核。
  `INVALID_URL_DOMAIN` 例外地寫稽核，因為那是濫用訊號。
- **per-contact 限流的 KV key**：`rl_notifyc.{link_id}.{sha256(ref) 前 32 碼}_{視窗}`，不含 ref 明文。
- **已知限制**：`line_api.js` 在 LINE 回非 2xx 時會 `console.error` 該回應本文（既有行為，未改動）；測試用的 LINE 回應不含敏感內容，
  真實的 LINE 錯誤本文一般是 `{message, details[{message, property}]}`，沒有使用者文字。

### 12.3 營運備註

- **沒有資料庫遷移**：用既有的 `idempotency`、`contacts`、`audit_log`、`products.url_domains`（`system` 欄無 CHECK／FK）。
- 合併部署後 Bridge 仍受 `BRIDGE_ENABLED=1` 控制；旗標關閉時 `/bridge/*` 全部 404，行為不變。
- 產品要能用 action 按鈕，必須先在產品登記（`POST /bridge/v1/admin/products`）時填好 `url_domains`；沒有登記網域的產品只能發純文字通知。
- 連結金鑰的 scope 需含 `messages:send`（連結流程本來就會發）；系統金鑰（`raw:push`）打 `/messages` 一律 401。

### 12.4 無法在單元測試中驗證的事

- 真實 LINE 對 Flex bubble 的渲染（排版、換行、按鈕外觀）與 `altText` 在通知列的呈現：待 3B-2 真機。
- 真實 D1 的並行語意（測試用 Miniflare 內的 SQLite，語意相近但不是正式 D1）。
- LINE 對 `X-Line-Retry-Key` 重送的 409 行為只用模擬回應驗證。

## 13. LM-3B-2 實測結果（2026-11-17，正式環境、真實官方帳號）

以暫時測試頁（已移除；需要時可從 git 歷史 `pages/bridge_msg_test.html`、`js/bridge_msg_test.js` 找回）在手機完成。**以下為操作者回報，未逐項留證**：

| 項目 | 結果 |
|------|------|
| 綁定後發送通知 → 手機收到（標題、內文、按鈕） | 通過（操作者回報） |
| 同鍵同內容重送 → 不會收到第二則 | 通過（操作者回報） |
| 同鍵不同內容 → 422 | 通過（操作者回報） |
| 網域不在白名單 → 422 | 通過（操作者回報） |
| 內文含 `http://` → 400 | 通過（操作者回報） |
| 未綁定的 ref → 409 | 通過（截圖確認：`CONTACT_NOT_BOUND`，當時為 `pending` 尚未傳出綁定碼） |
| 封鎖 OA 後發送 → 409 `RECIPIENT_BLOCKED`；解除封鎖後恢復 200 | **未回報**，視為未驗證（另見 lm-3a-plan §14 的封鎖與還原） |

未在真實 D1 上驗證：並行重送、限流邊界；LM-3E 的自動化 E2E 應補上。

> **更新（M-01，2026-11；見 `lm-sec-plan.md`）**：限流已由 KV 固定視窗改成 D1 原子計數（每連結 60 則／分鐘、每（連結, ref）10 則／小時，沿用），
> 並**新增每連結每日 500 則的預算**（env `BRIDGE_LINK_DAILY_CAP`），用盡回 `QUOTA_EXCEEDED`（402），用到 80% 寫稽核 `usage_high`。
> 計數鍵為 D1 `counters.scope_key`（`send:min:{link}`、`send:hour:{link}:{sha256(ref) 前 32 碼}`、`send:day:{link}`），不含 ref 明文；
> 缺 migration 0004 時發送回 503（fail-closed）。上文提到的 KV key（`rl_notifyc.…`）與「缺 KV 時 fail-open」已不適用於發送路徑。
