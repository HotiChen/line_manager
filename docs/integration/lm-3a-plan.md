# LM-3A 設計：聯絡人綁定（綁定碼訊息）

狀態：3A-1（後端）已實作，實作與設計的差異見第 13 節；3A-2（真機實測）未做。前置：LM-2A（連結與連結金鑰）已上線並實測。
決策依據：gap-analysis D-3（綁定走「客戶傳綁定碼給 OA」，不走 LINE Login）、`ARCHITECTURE_PLATFORM.md` 資料歸屬原則
（LM 只存 LINE 側資料；產品只用不透明的 `external_contact_ref`，永遠拿不到 LINE userId）。

## 1. 目標與不做的事

目標：產品（用連結金鑰）替它的某位客戶要一組綁定碼 → 客戶在該官方帳號的 1 對 1 聊天室傳出這組碼 →
LM 的 webhook 認出碼，記下「這個 `external_contact_ref` = 這個 LINE userId」→ 產品查狀態得知已綁定。

不做（留給後續）：
- 受限 `/messages` 推播（LM-3B）；產品端事件回傳（outbound webhook）—— 3A 只提供「產品輪詢狀態」。
- 群組／聊天室綁定（架構文件的 `LM-` 群組碼那條路）。3A 只處理 `source.type === "user"`。
- 後台頁面。3A 沒有前端。

## 2. 流程

```
產品                       LM                          客戶（LINE）
 │ POST /contacts/bind-tokens │                            │
 │ {external_contact_ref}     │                            │
 ├───────────────────────────►│ 產碼（只存雜湊）            │
 │◄───────────────────────────┤                            │
 │ {bind_code, bind_url,      │                            │
 │  expires_at}               │                            │
 │ ── 把 bind_url / 碼給客戶 ─────────────────────────────►│
 │                            │◄───── 在 OA 聊天室傳碼 ─────┤
 │                            │ webhook message(text)       │
 │                            │ 認出碼 → 寫入綁定 → 回一則確認│
 │ GET /contacts/{ref}        │                            │
 ├───────────────────────────►│                            │
 │◄── {status:"bound"} ───────┤（不含 userId／名稱／頭像）   │
```

## 3. 資料模型（migration 0003）

`bind_codes`
| 欄位 | 說明 |
|---|---|
| `code_hash` TEXT PK | SHA-256(碼)；不存明文 |
| `link_id` TEXT | 發碼的連結 |
| `bot_id` TEXT | 該連結的 bot（綁定只會在這個 OA 的 webhook 生效） |
| `external_contact_ref` TEXT | 產品給的代號 |
| `created_at`, `expires_at` INTEGER | TTL 7 天 |
| `used_at` INTEGER NULL | 單次使用：`UPDATE … WHERE used_at IS NULL`，`meta.changes === 1` 才算搶到 |

`contacts`
| 欄位 | 說明 |
|---|---|
| `link_id`, `external_contact_ref` | 複合 PK |
| `bot_id` | |
| `line_user_id` TEXT | **只存在這張表**；任何 API 回應、audit、log 都不得出現 |
| `status` | `bound`／`blocked`（`unfollow` 事件）；`unbound`、`pending`、`disabled` 是查詢時推導（見 §5），不存 |
| `bound_at`, `updated_at` INTEGER | |

索引：`contacts(bot_id, line_user_id)`（unfollow／follow 事件查詢）、`bind_codes(link_id, external_contact_ref)`（作廢舊碼）、
`bind_codes(expires_at)`（清理）。

## 4. 綁定碼

- 格式：`LM-` + 8 碼 Crockford base32（去 I/L/O/U），約 40 bits；`crypto.getRandomValues` 產生。
- 有效 7 天、單次使用。同一 (連結, ref) 再要一次碼 → **先把舊的未用碼全部作廢**，只留最新一組。
- **辨識規則**：訊息文字 `trim()` 後、轉大寫，**完全符合** `^LM-[0-9A-HJKMNP-TV-Z]{8}$`，才算「長得像綁定碼」；
  不做前綴或模糊比對（客人正常聊天不會誤觸）。
- 長得像但查無此碼（錯、過期、已用、別的 OA 的碼）：**不回任何訊息**，照原流程繼續（關鍵字比對）。
  理由：回「碼錯誤」等於給猜碼者一個判斷機（oracle）。
- 比對時一併帶 `bot_id = 事件的 destination`：A 官方帳號發的碼，在 B 官方帳號傳出無效。
- 防暴力猜：以 (`bot_id`, LINE userId) 用既有 KV 限流器限制嘗試次數（fail-open 屬既有行為，已知限制）。
  40 bits 的空間加上「7 天有效、單次使用、需成為好友才能傳」，實務上不可猜；限流是額外一層。

## 5. 端點（link key + `contacts:bind`，錯誤一律 `bridgeError` 格式）

| 方法 路徑 | 說明 |
|---|---|
| `POST /bridge/v1/contacts/bind-tokens` | body `{external_contact_ref}` → 201 `{bind_code, bind_url, expires_at}` |
| `GET /bridge/v1/contacts/{external_contact_ref}` | → 200 `{external_contact_ref, status, bound_at}` |
| `DELETE /bridge/v1/contacts/{external_contact_ref}` | 解除綁定（刪除該列並作廢待用碼）→ 204；給「客戶要求刪除」用 |

`external_contact_ref`：`^[A-Za-z0-9_-]{8,64}$`（沿用 bridge-v1.yaml）。路徑上的 ref 只在**這條連結**的範圍內查
（不同連結、不同產品之間完全隔離）。

狀態推導（`GET`）：連結已撤銷或產品停用 → `disabled`；有 `contacts` 列且 `blocked` → `blocked`；有列 → `bound`；
無列但有未過期未用的碼 → `pending`；其餘 → `unbound`。

連結被撤銷後，所有綁定自然失效（`disabled`），不需要逐列改寫；連結金鑰本來就已無法呼叫端點。

## 6. Webhook 接入點

在 `lib/event_handler.js` 的 `handleMessageEvent` 最前面（文字訊息、`source.type === "user"`、有 `userId`）呼叫
`bridge/binding.js` 的 `tryConsumeBindCode(env, { botId, lineUserId, text })`：

- `BRIDGE_ENABLED !== "1"` → 直接回 `{handled:false}`（旗標關閉時行為與今天完全相同）。
- 文字不像綁定碼 → `{handled:false}`，零 D1 查詢，不增加一般訊息的延遲。
- 像且成功消耗 → 寫入 `contacts`（同 (連結, ref) 已有綁定則**覆蓋**成新的 userId，更新 `bound_at`），
  回覆一則確認文字（reply API，免費），並 `{handled:true}`，**不再跑關鍵字回覆**，避免同一則訊息回兩次。
- 任何錯誤（D1 失敗等）→ 記訊息（不含碼與 userId）、`{handled:false}`，不影響既有回覆流程。

`unfollow` 事件：把 `contacts` 中 (`bot_id`, `line_user_id`) 的列設為 `blocked`；`follow` 事件把 `blocked` 還原為 `bound`
（只限先前綁定過的列）。**不**新建綁定。

Bridge 與 LM 的邊界：`bridge/binding.js` 只經 `lm_service` 的窄介面取得 LM 資料；`lib/event_handler.js`
是 LM 這一側，單向呼叫 `bridge/binding.js`（現有 `index.js` 已有同方向的分派）。SQL 仍只在 `bridge/db.js`。

## 7. bind_url（需實測）

綁定碼可以做成 LINE 的預填訊息連結：`https://line.me/R/oaMessage/{basicId}/?{url-encoded 文字}`。
`basicId`（形如 `@123abcde`）來自 LINE `GET /v2/bot/info`（回傳欄位含 `basicId`），用該 OA 的 access token 取得，
新增 `lm_service.getBotBasicId(env, botId)`。**第一步先用你的真實 OA 驗證 `basicId` 有沒有回、連結能否預填**
（gap-analysis 已列為風險）。

驗證不過或取不到時：`bind_url` 回 `null`，產品改成「顯示碼，請客戶自己傳給 OA」。因此 bridge-v1.yaml 的
`bind_url` 要改為 nullable（本設計的規格變動，見 §10）。

## 8. 安全與隱私

- 碼只存 SHA-256；API 回應只在建立當下回一次明文。
- `line_user_id` 不進任何回應、audit `detail`、console；`sanitizeDetail` 白名單不加它。
- audit：`contact_bind_token_created`、`contact_bound`、`contact_unbound`（`detail` 僅含 `product_id`、`link_id`；
  **不含 ref？** 見 §9 問題 5）。
- 同一個 LINE userId 可綁到同一連結的不同 ref（例如家人共用帳號）；是否限制見 §9 問題 4。
- 連結金鑰只能操作自己連結的 contacts；跨連結的 ref 一律 404（沿用 2A 的 `ownLink` 思路）。
- 為 bind-tokens 加上限流（每連結），並限制每連結同時有效的未用碼數量（預設 1000），防止灌爆表。

## 9. 需要你確認的事

1. **碼格式與 TTL**：`LM-` + 8 碼、7 天、單次使用，可以嗎？
2. **不做 Idempotency-Key**：bridge-v1.yaml 寫 `POST /contacts/bind-tokens` 吃冪等鍵；3A 改成「同 (連結, ref) 重要就作廢舊碼、發新碼」。
   碼只存雜湊，沒辦法「重送同一組」。這樣可以嗎？
3. **查無此碼時不回應**（§4）：客人傳了錯的碼，OA 沉默。可接受嗎？（替代：回「找不到，請向店家確認」，代價是可被當判斷機。）
4. **重綁政策**：同 (連結, ref) 已綁定 A，再用新碼從 B 綁 → 覆蓋成 B。同一個 userId 綁多個 ref 則允許。可以嗎？
5. **audit 要不要記 ref**：ref 是產品自己的不透明代號，記進去方便對帳，但稽核表會累積識別碼。預設：**不記**。
6. **DELETE 端點**要不要在 3A 就做？（對應「客戶要求刪除」；不做則只能靠 D1 手動清。）預設：做。
7. **「綁定保留 30 天」**（gap-analysis 第 13 節待確認）：我的理解是「連結撤銷後保留 30 天再清除 contacts」，
   3A 先不做自動清除，只在文件註記；要不要之後補排程清理？
8. **確認訊息文字**：綁定成功後 OA 回「已完成綁定，之後會在這裡通知你」，可以嗎？（可之後改）

## 10. 規格與文件的變動

- `bridge-v1.yaml`：`bind_url` 改 nullable；移除 bind-tokens 的 `Idempotency-Key`（若問題 2 同意）；新增 `DELETE /contacts/{ref}`；`x-status` 改 implemented。
- `ARCHITECTURE_PLATFORM.md`：標記聯絡人綁定（user 目標）已實作；群組碼路徑仍未做。

## 11. 工作切分

- **3A-1 後端**：migration 0003、`bridge/db.js` 新函式、`bridge/contacts.js`（三個端點）、`bridge/binding.js` + webhook 接入、
  `lm_service.getBotBasicId`、unfollow／follow 處理、單元與 Miniflare D1 測試、ESLint 邊界測試更新。
- **3A-2 實測**：你在遷移 0003 套用到 `bridge-db` 後，用真實 OA 與手機驗證 §7（basicId／預填連結）與完整綁定流程。
  會需要一個暫時測試頁（同 2A-3），測完刪除。
- 上線順序：先套 0003（D1 Console 貼 SQL）→ 部署 → 開旗標實測。旗標關閉時行為與現在相同。

## 12. 測試策略

- 單元／D1：碼格式與辨識（含大小寫、空白、近似字串不誤觸）、單次使用與並行（`meta.changes`）、過期、跨 bot 無效、
  舊碼作廢、覆蓋綁定、狀態推導五種、連結撤銷 → `disabled`、跨連結 ref 隔離、DELETE、unfollow／follow。
- 回應與 audit **不含** `line_user_id` 與碼（掃描斷言）。
- webhook：旗標關閉時 `handleMessageEvent` 行為不變；綁定成功後不觸發關鍵字回覆；D1 失敗時退回既有流程。
- 邊界：`test_bridge_db_boundary`（SQL 只在 `bridge/db.js`）、`test_import_boundary`。

## 13. 實作與設計的對照（3A-1 實作時的決定）

檔案：`migrations/0003_bridge_contacts.sql`（新）、`worker_src/bridge/{contacts,binding}.js`（新）、`db.js`／`routes.js`／`index.js`／`links.js`（擴充；`links.js` 只是把幾個小工具加上 `export`）、
`worker_src/lm_service.js`（新增 `getBotBasicId`）、`worker_src/lib/event_handler.js`（webhook 接縫）。
測試：`tests/unit/test_bridge_binding.mjs`（資料層與 webhook 側邏輯）、`test_bridge_contacts.mjs`（端點，經 `handleBridge`）、`test_event_handler_binding.mjs`（事件處理器）；
`test_bridge_migration.mjs`、`test_lm_service.mjs`、`test_import_boundary.mjs`、`test_bridge_db_boundary.mjs` 同步更新；`tests/helpers/bridge_seed.mjs` 新增 `seedLink`、`countingDb`。

### §9 八個問題的決定（採預設答案）

1. 碼：`LM-` + 8 碼 Crockford base32（字母集 `0-9A-HJKMNP-TV-Z`，32 個字元所以取低 5 bit 無偏差）、7 天、單次使用。
2. 不做 `Idempotency-Key`：同 (連結, ref) 再要碼 → 舊的未用碼**刪除**（不是標記已用），只留最新一組；`bridge-v1.yaml` 已移除該參數。
3. 長得像但查無此碼 → 不回任何訊息，落到一般關鍵字流程。
4. 同 (連結, ref) 從新的 LINE 使用者重綁 → 覆蓋（狀態回 `bound`、`bound_at` 更新）；同一個使用者可綁同連結的多個 ref。
5. audit 不記 `external_contact_ref`、`line_user_id`、碼；`detail` 只有 `product_id`、`link_id`。`sanitizeDetail` 白名單沒有新增任何欄位（測試釘住）。
6. 做 `DELETE /contacts/{ref}`。
7. 不做 30 天自動清除。連結撤銷後 `contacts` 與 `bind_codes` 的列原封保留（狀態推導為 `disabled`），要清要手動：
   `DELETE FROM contacts WHERE link_id = '…'; DELETE FROM bind_codes WHERE link_id = '…';`。過期超過 1 天的 `bind_codes` 會在每次發碼時順手清掉。
8. 確認訊息：「已完成綁定，之後會在這裡通知你」（常數 `BIND_CONFIRM_TEXT`）。

### 設計稿沒寫死、實作時決定的事

- **DELETE 一律冪等**：不論原本有沒有綁定或待用碼都回 204（不回 404，避免洩漏 ref 是否存在過）。只有「實際刪到東西」才寫 `contact_unbound` audit。同時作廢該 ref 全部綁定碼。
- **錯誤碼**：body 的 `external_contact_ref` 不合法 → 400 `INVALID_REQUEST`；路徑上的 ref 不合法或無法解碼 → 404 `NOT_FOUND`（認證通過後才判斷，與 `links.js` 的 `ownLink` 同一思路）；
  不認得的路徑／方法 → 404 `NOT_FOUND`（認證之前，與 `links.js` 相同）。字面 ref `bind-tokens` 因此無法當作 ref 使用（`GET /contacts/bind-tokens` 是 404）。
- **限流**：`POST bind-tokens` 每連結每分鐘 30 次（KV 限流器，fail-open 屬既有行為）；每連結有效未用碼上限 1000，達上限回 429 `RATE_LIMITED`。
  上限檢查與寫入是同一個 `INSERT … SELECT … WHERE COUNT(*) < 上限`，且上限不計「同 ref 即將被取代的舊碼」，所以已有碼的 ref 在上限滿時仍可換新碼；被擋下時舊碼原封不動。並行請求可能讓數量短暫略超過 1000（護欄，不是精確配額）。
- **消耗碼時多檢查連結仍是 active**：連結已撤銷時發出的碼視為無效（不建立綁定，也不燒掉碼）。
- **消耗與寫入綁定是兩個 D1 呼叫**：先 `UPDATE … used_at`（搶碼，`meta.changes === 1`），再 upsert `contacts`。兩者之間若 D1 失敗，碼已被燒掉、沒有綁定，客戶會落到一般關鍵字流程；產品重要一組新碼即可（不做補償，避免多一條會重複綁定的路徑）。
- **辨識**：用 `/^LM-[0-9A-HJKMNP-TV-Z]{8}$/i` 對 `trim()` 後的原文比對，再轉大寫雜湊。刻意不先 `toUpperCase()` 再比對：`ſ`（U+017F）大寫後會變 `S`，會讓非 ASCII 字元混進來。
- **嘗試限流**：只有「長得像綁定碼」的訊息才計次；以 (`bot_id`, LINE userId) 每分鐘 10 次。一般訊息不碰 KV、不碰 D1。
- **webhook 接縫**：`event_handler.js` 在記錄使用者訊息之前呼叫 `tryConsumeBindCode`，所以成功消耗的碼不會進既有的訊息 log。確認訊息用既有的 `replyWithRetry`，送不出去只記 log、不丟錯（綁定已完成）。
  `unfollow`／`follow` 呼叫 `markBlocked`／`restoreFollow`（放在既有處理之前，因為既有處理可能丟錯）；兩者與 `tryConsumeBindCode` 都絕不丟錯、旗標關閉時零 D1／零 KV。
- **import 邊界**：LM 側原本一律不得 import `bridge/`（只有 `index.js` 例外）。現在加了一個明列的單向接縫：`lib/event_handler.js` 只准 import `bridge/binding.js`
  （`tests/helpers/import_boundary.mjs` 的 `LM_SIDE_BRIDGE_ALLOWED` 與 `eslint.config.js` 兩層防線同步，有測試證明其他 bridge 模組與其他 LM 檔案仍被擋）。
- **audit actor**：`contact_bind_token_created`、`contact_unbound` 為 `service_key`／連結 id；`contact_bound` 來自 webhook，為 `system`／`webhook`，`bot_id` 為事件的 destination。
- **`bind_url`**：`https://line.me/R/oaMessage/@<basicId 去掉 @ 後 encodeURIComponent>/?<encodeURIComponent(完整碼)>`。`basicId` 須符合 `^@?[A-Za-z0-9._-]{1,64}$`（沒有 `@` 就補上），否則回 `null`。
  `getBotBasicId` 每次發碼都打一次 `GET /v2/bot/info`（3 秒逾時，任何失敗回 `null`，不丟錯、不記 token）；沒有快取（發碼已有限流）。
- **`bridge/links.js` 小改**：`json`、`noContent`、`rateLimited`、`readJsonBody`、`isoOrNull` 加 `export` 給 `contacts.js` 共用，行為不變。

### 重新授權時綁定跟著走

規則：同一產品在同一 bot 重新授權（`links/token` 取代既有 active 連結）時，`createLinkWithKey` 在撤銷舊連結的**同一個 batch** 內，
把被取代連結名下的 `contacts`，以及「未用且未過期」的 `bind_codes`，其 `link_id` 改成新連結（UPDATE）。
- 只動「這次被取代的連結」：UPDATE 以 `status = 'active'` 篩選，並排在撤銷敘述**之前**（設計要求「撤銷之後」，但撤銷之後就分不出哪些是這次撤銷的，先做等價且更精確；同一個 batch，結果一致）。
- 明確撤銷（連結金鑰 `DELETE /links/{id}`、後台撤銷）後再授權：舊連結已不是 active，**不遷移**（撤銷即切斷），新連結是 `unbound`，舊碼無效。
- 已用或已過期的碼留在舊連結；其他產品、其他 bot 的連結不受影響；新連結剛建、沒有任何列，不會有主鍵衝突。
- audit 沒有新增任何識別碼（遷移不寫 audit）。測試在 `test_bridge_contacts.mjs` 的「重新授權」一節。

### 已知限制（要在 3A-2 或之後處理）

- ~~綁定掛在 `link_id` 上，重新授權會讓綁定消失~~：**已處理**（見下方「重新授權」）。
- **`bind_url` 的預填連結形式未在真實 OA 驗證**（見下）。
- 嘗試限流與發碼限流都是 KV 固定窗，缺 KV 或 KV 出錯時 fail-open（既有行為）。

### 操作手冊（部署後由人執行）

1. **先套遷移，再開使用**：把 `migrations/0003_bridge_contacts.sql` 整份貼到 Cloudflare Dashboard → D1 → 該資料庫 → Console，**整份只貼一次**（不是 `IF NOT EXISTS`，重複套用會失敗）。
   正式資料庫 `bridge-db` 與開發資料庫 `bridge-db-dev` 都要各套一次。
2. 驗證：在 Console 執行
   `SELECT type, name FROM sqlite_master WHERE name IN ('bind_codes','contacts','idx_bind_codes_ref','idx_bind_codes_expiry','idx_contacts_user') ORDER BY type, name;`
   應回 5 列（2 張 table、3 個 index）。
3. 部署後 `BRIDGE_ENABLED=1` 才會啟用綁定；旗標關閉時 webhook 行為與以前完全相同。未套遷移就開旗標：發碼端點會回 503；webhook 側的綁定碼辨識會安靜失敗並退回既有流程（log 只有 D1 錯誤訊息）。
4. 真機驗證（3A-2）：用真實 OA 確認 `bind_url` 是否能在手機上預填碼、`basicId` 有沒有回、完整綁定流程與 unfollow／follow。

## 14. LM-3A-2 實測結果（2026-11-17，正式環境、真實官方帳號）

以暫時測試頁（已移除；需要時可從 git 歷史 `pages/bridge_bind_test.html`、`js/bridge_bind_test.js` 找回）在手機完成。**以下為操作者回報，除註明外未逐項留證**：

| 項目 | 結果 |
|------|------|
| LINE `/v2/bot/info` 回 `basicId`、預填連結 `line.me/R/oaMessage/…` 可用 | 通過（操作者回報預填連結出現並可用） |
| 傳出綁定碼 → webhook 認出 → OA 回確認訊息 | 通過（操作者回報） |
| 綁定後狀態 `bound` | 通過（操作者回報） |
| 別人的 ref 查詢 → `unbound` | 通過（操作者回報） |
| 解除綁定 204、之後 `unbound` | 通過（截圖確認：204，連續兩次查詢 `unbound`） |
| 一般訊息與關鍵字回覆不受影響 | **未驗證** |
| 封鎖 OA → `blocked`、解除封鎖 → 還原 `bound` | **未驗證**：操作者稱有照順序操作，但沒有留下該段結果；僅有單元測試。若日後發現封鎖後狀態仍是 `bound`，從 `handleUnfollowEvent`（`lib/event_handler.js`）與 `binding.markBlocked` 查起 |

未在真實 D1 上驗證的：並行搶碼、每連結 1000 碼上限（Miniflare 測試已涵蓋）。LM-3E 的自動化 E2E 應補上。
