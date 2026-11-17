# LM-3A 設計：聯絡人綁定（綁定碼訊息）

狀態：設計，尚未實作。前置：LM-2A（連結與連結金鑰）已上線並實測。
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
