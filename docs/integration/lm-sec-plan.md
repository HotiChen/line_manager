# 安全審查修正設計（M-01～M-03）

來源：`lm-3e-security-review.md`（2026-11-18）。本文記錄決定與做法；實作完成後在 §6 補對照。
範圍：`M-01` 額度耗盡、`M-02` 綁定碼與覆蓋、`M-03` 同意頁導向網址顯示與 `state` 要求。其餘 Low 項目不在這一輪。

## 1. 決定（皆採審查報告的建議，使用者已同意「開始修」）

| # | 決定 |
|---|---|
| D1 | 用 D1 原子計數取代 KV 限流器來保護 Bridge 的發送與綁定：單一 `INSERT … ON CONFLICT DO UPDATE … WHERE n < cap`，以 `meta.changes` 判斷是否放行。KV 限流器不動（既有功能仍用）。 |
| D2 | 發送預算：每連結每分鐘 60 則、每（連結, ref）每小時 10 則（沿用現有數字）、**新增每連結每日 500 則**（預設；可由環境變數 `BRIDGE_LINK_DAILY_CAP` 調整）。超過回 `RATE_LIMITED`（分鐘、小時）或 `QUOTA_EXCEEDED`（日預算），都不打 LINE。 |
| D3 | 異常用量：日預算用到 80% 時寫一筆稽核 `usage_high`（每連結每日一次）。不自動停用連結（先觀察）。 |
| D4 | 綁定碼加長為 `LM-` + 12 碼 Crockford base32（60 bit），顯示成 `LM-XXXX-XXXX-XXXX`；TTL 由 7 天改為 **48 小時**。辨識時接受有無連字號；**舊的 8 碼碼在過渡期（發出後 7 天內）仍可消耗**，之後移除相容。 |
| D5 | 綁定嘗試限流改為 D1 原子計數，加上每 bot 維度：每 bot 每分鐘最多 30 次「像綁定碼但查無此碼」；超過時該 bot 暫停辨識綁定碼 5 分鐘（回 `{handled:false}`，不查資料庫）並寫稽核 `bind_paused`（每 bot 每小時一次）。每（bot, LINE 使用者）每分鐘 10 次維持，改用 D1。 |
| D6 | 覆蓋既有綁定預設拒絕：`POST /contacts/bind-tokens` 新增選填 `allow_rebind`（預設 false）。碼被不同的 LINE 使用者消耗、且該 (連結, ref) 已綁定給另一人時：`allow_rebind` 為 false → **不消耗碼**、不覆蓋、OA 保持沉默、寫稽核 `bind_rejected`；為 true → 覆蓋，並對**原綁定者**推一則「你的綁定已被更換」（失敗不影響結果）。同一個 LINE 使用者重綁自己 → 視為成功（冪等）。 |
| D7 | 同意頁顯示已驗證的 `redirect_uri` **主機名稱**（`textContent`，不做成連結）與一句「授權後，你的客戶可綁定並收到來自 {OA 名} 的通知」。`bridge-v1.yaml` 的 `/link/authorize` 加上 MUST：`state` 必須不可預測、綁定發起者的 session、回調時驗證；契約測試檢查該敘述存在。 |

## 2. 資料庫（migration 0004）

```sql
-- 原子計數：scope_key 例 'send:min:{link}'、'send:hour:{link}:{refhash}'、'send:day:{link}'、'bindfail:{bot}'、'binduser:{bot}:{userhash}'
CREATE TABLE counters (
  scope_key   TEXT    NOT NULL,
  window      INTEGER NOT NULL,        -- 視窗起點（毫秒，已對齊）
  n           INTEGER NOT NULL,
  PRIMARY KEY (scope_key, window)
);
CREATE INDEX idx_counters_window ON counters (window);

-- 暫停旗標與一次性稽核旗標
CREATE TABLE flags (
  flag_key    TEXT PRIMARY KEY,
  until_at    INTEGER NOT NULL
);

ALTER TABLE bind_codes ADD COLUMN allow_rebind INTEGER NOT NULL DEFAULT 0;
```

- `scope_key` 中的 ref 與 LINE userId 只存 SHA-256 前 32 碼，**不存明文**（隱私）。
- 計數列清理：寫入時順手刪除超過 2 天的視窗（`DELETE FROM counters WHERE window < ?`，限制每次最多一次／機率性即可）。
- 部署後由人在 D1 Console 對 `bridge-db`（與 `bridge-db-dev`）各貼一次整份 0004；Bridge 旗標關閉時不受影響。**未套用遷移就開旗標時，發送與綁定要 fail-closed（503 `bridge_not_configured`，不是放行）。**

## 3. 實作要點

- `bridge/db.js` 新增 `takeToken(env, { key, windowMs, cap, now })`：回傳 `{allowed, count}`；單句 UPSERT，`meta.changes === 1` 放行。`setFlag/getFlag` 用 `flags`。所有 SQL 仍只在 `db.js`。
- `bridge/notify.js`：以 D1 計數取代 `checkRateLimit` 的兩個 KV 限流，加日預算；順序維持「認證 → 驗證 → 限流 → 冪等 → …」，被擋的請求不觸及 LINE。
- `bridge/binding.js`：新碼格式產生與辨識（含舊碼相容）、D6 的覆蓋判斷放在**消耗碼之前**，D5 的計數與暫停。
- `bridge/contacts.js`：`allow_rebind` 欄位驗證（boolean，未知欄位維持現行處理）；回應不變。
- `pages/link_authorize.html` / `js/link_authorize.js` / `helper/link_authorize_form.js`：顯示主機名稱。
- `bridge-v1.yaml`：`bind_code` 範例與格式、`allow_rebind`、`state` 的 MUST；契約測試同步。

## 4. 測試要求

- 並行：N 個並行送出，實際送出數不得超過預算（含日預算）；預算耗盡不打 LINE；視窗邊界用 `withPinnedWindow`。
- 綁定：新碼格式辨識（含大小寫、連字號、近似字串不誤觸）、舊 8 碼相容與過期、每 bot 失敗上限後暫停且不查資料庫、覆蓋預設拒絕且碼不被消耗、`allow_rebind` 覆蓋並通知原綁定者、同使用者重綁冪等。
- 隱私：計數鍵不含明文 ref／userId（掃描斷言）；稽核 `detail` 不含 ref／userId／碼。
- 同意頁：顯示主機名稱、不是連結、`textContent`；契約文件含 `state` 的 MUST。
- 缺 0004 的資料庫（只套 0001～0003）：發送與綁定回 503，不放行。

## 5. 風險與已知限制

- 日預算與計數在**單一 D1** 內原子；跨區域一致性屬 D1 的保證，真實行為**未驗證**。
- 暫停機制可被用來對特定 bot 做阻斷（猜錯 30 次就暫停 5 分鐘）。這是可接受的取捨：影響範圍是「綁定新聯絡人」，不影響已綁定者的通知與一般訊息。
- `allow_rebind` 為 true 時仍可被持有連結金鑰的產品濫用（換綁到攻擊者），但此時要有該 ref 的新綁定碼＋攻擊者實際傳訊息，且原綁定者會被通知。

## 6. 實作與設計的對照

實作完成（2026-11-18，程式與測試；**尚未部署**）。測試由 1747 增至 1836 以上；`npm test` 全綠、`npx eslint worker_src tests --quiet` 乾淨。

### 部署與營運（先做這個）

1. **在下一次部署被使用之前**，對 `bridge-db` 與 `bridge-db-dev` 各貼一次整份 `migrations/0004_bridge_counters.sql`（D1 Console；整份只能貼一次，重複會明確失敗）。
2. 驗證：`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('counters','flags');` 應回兩列；`PRAGMA table_info(bind_codes);` 應含 `allow_rebind`。
3. **未套用 0004 且 `BRIDGE_ENABLED=1` 時**：`POST /bridge/v1/messages` 與 `POST /bridge/v1/contacts/bind-tokens` 回 **503 `bridge_not_configured`**；webhook 收到長得像綁定碼的文字時不綁定（照原流程回覆）。不是放行。旗標關閉（`BRIDGE_ENABLED` ≠ 1）不受影響。
4. 可選：`BRIDGE_LINK_DAILY_CAP`（wrangler vars）調整每連結每日預算；缺、空、非正整數一律用預設 500。

### 與設計一致的部分

- D1／D2／D3：`bridge/db.js` 的 `takeToken`（單句 UPSERT `… WHERE n < cap RETURNING n`）；`notify.js` 的分鐘 60／（連結, ref）小時 10／連結每日 500；日預算用盡 `QUOTA_EXCEEDED` 402，分鐘與小時 `RATE_LIMITED` 429 + `Retry-After`（距視窗結束的秒數，至少 1）；80% 寫 `usage_high`（旗標每連結每日一次）。不打 LINE 的順序維持「認證 → 驗證 → 限流 → 冪等 → 聯絡人 → 額度 → LINE」。
- D4：`LM-` + 12 碼（`crypto.getRandomValues`，字母表 32 字元所以取低 5 bit 無偏差），顯示 `LM-XXXX-XXXX-XXXX`，TTL 48 小時；辨識接受有無連字號、不分大小寫、trim；舊 8 碼相容（雜湊用「無連字號標準形」，所以舊碼的雜湊不變）。
- D5：每（bot, 使用者）每分鐘 10 次；每 bot 每分鐘 30 次「查無此碼」→ 暫停 5 分鐘（`flags`）＋稽核 `bind_paused`（每 bot 每小時一次）。暫停期間 webhook 只做一次 `flags` 查詢，不查碼。
- D6：`allow_rebind`（boolean，預設 false；非 boolean → 400）；拒絕時碼不被消耗、OA 沉默、稽核 `bind_rejected`；`true` 才覆蓋並對原綁定者推「你的綁定已被更換」（盡力而為）；同一使用者重綁自己視為成功。
- D7：同意頁顯示 `URL.hostname`（`textContent`、不是連結）與「授權後，你的客戶可綁定並收到來自 {OA 名} 的通知」；`bridge-v1.yaml` 的 `/link/authorize` 有 MUST 段落，契約測試檢查它存在。

### 與設計稿不同或設計稿沒寫死的決定（偏差一覽）

| # | 內容 | 原因 |
|---|---|---|
| 1 | **覆蓋判斷、消耗碼、寫入綁定放在同一個 D1 batch**（`consumeBindCode(env, {codeHash, botId, lineUserId})` 現在也負責寫 contacts；原本的「先消耗、再 `upsertContactBinding`」兩步合併）。被拒絕＝UPDATE 的條件不成立（`allow_rebind = 1 OR NOT EXISTS(別人的綁定)`），所以碼不會被燒掉，也沒有檢查與消耗之間的空檔；寫綁定用 `WHERE changes() = 1` 綁在 UPDATE 的結果上（不用 `used_at = now`，同毫秒搶同一組碼時輸家也會看到 used_at = now）。`upsertContactBinding` 仍保留匯出（測試與其他用途）。 | 設計稿只說「消耗之前判斷」；分兩步會留下「A 消耗後、B 在 A 寫入前也通過檢查」的窄競態。 |
| 2 | 「原綁定者」不另開函式，而是 `consumeBindCode` 的回傳值 `previousUserId`（只有「覆蓋了別人」時才有）。`test_bridge_db_boundary` 的允許清單**精確**改成「恰兩句 SELECT 讀 `line_user_id`」：`getContactForSend` 與 `consumeBindCode` 內「同 (連結, ref)」的子查詢，且 `consumeBindCode`／`previousUserId` 只有 `binding.js` 使用。 | 原綁定者必須在覆蓋「之前」讀，放在同一個 batch 才一致。 |
| 3 | 每 bot 的失敗預算是「**先扣、查到碼（成功或被拒）再還**」，而不是「查無此碼才計」。 | 先計後查的做法在並行猜碼時，N 個請求會全部通過檢查才一起失敗；先扣讓並行下實際查碼數也不超過 30（有並行測試）。副作用：30 個以上真人在同一分鐘內「同時」綁定同一個 bot，可能誤觸暫停（一般流量不會）。 |
| 4 | 被拒絕的覆蓋視為「碼是真的」，不計入失敗預算、不觸發暫停。 | 它不是猜錯；持碼者可重試（每使用者每分鐘 10 次限制仍在）。 |
| 5 | 名額在「驗證通過之後、`action.url` 檢查之前」扣：分鐘 → 小時 → 日。被後面的限制擋下、冪等重送（回放、IN_PROGRESS、鍵重用）、`action.url` 不在白名單（只保留每分鐘那一格）時，**把名額還回去**（`giveBackTokens`）；其餘嘗試（聯絡人未綁定、LINE 失敗）不還。格式錯誤（400）不扣。 | 設計稿要求「重送不吃預算」要決定並文件化；全部不還則 LINE 失敗會讓日預算被重試吃光。測試釘住。 |
| 6 | 順序變更：舊版限流在 `Idempotency-Key` 檢查與本文驗證**之前**；新版在驗證**之後**。 | 設計稿的順序（認證 → 驗證 → 限流 → 冪等）。原本以格式錯誤請求吃光限流額度的測試改寫成以未綁定 ref 的有效請求。 |
| 7 | 冪等重送若遇到限流，會得到 429（而不是回放）。 | 限流在冪等之前（設計稿順序）；回放不吃預算，但限流本身仍先判斷。 |
| 8 | 既有綁定為 `blocked`（原使用者封鎖了 OA）也算「已被別人綁定」，預設仍拒絕。 | 保守；要換綁就用 `allow_rebind`。 |
| 9 | 不更動 `bind-tokens` 本身的 KV 限流（每連結 30 次／分鐘）與 `MAX_LIVE_BIND_CODES_PER_LINK`。 | 不在 M-01～M-03 範圍。 |
| 10 | 同 (連結, ref) 再發碼仍作廢舊的未用碼（含 allow_rebind 碼）：新發的預設碼會取代較寬鬆的舊碼。 | 既有行為；不留下較寬鬆的舊碼。測試釘住。 |
| 11 | 計數清理：寫入時約 2% 機率順手刪除超過 2 天的計數視窗與超過 1 天的過期旗標；不排程。 | 設計稿「機率性即可」。 |
| 12 | 測試工具 `createTestD1({ upTo: '0003' })` 新增，用來模擬「缺 0004」。 | 設計稿要求測 fail-closed。 |

### 刻意改寫（不是刪除）的既有測試

- `test_bridge_notify.mjs`：「每連結每分鐘 60」改用有效的未綁定 ref 請求吃額度（限流現在在驗證之後）；「限流用的 KV key 不含 ref 明文」改為檢查 D1 `counters.scope_key`；「缺 KV 時限流 fail-open」改為「缺 KV 不影響限流」（仍回 503，因為沒有 token）。使用者可見行為（61 → 429、Retry-After、別條連結不受影響）不變。
- `test_bridge_binding.mjs`：「同 (連結, ref) 從新使用者重新綁定 → 覆蓋」改成「發碼時 `allowRebind: true` 才覆蓋」，並新增「預設不覆蓋」；碼格式／TTL／過期（7 天 → 48 小時）／並行 db 消耗（需帶 `lineUserId`）的斷言同步更新。
- `test_bridge_contacts.mjs`、`test_bridge_contract_*`：碼格式與 TTL；`test_bridge_migration.mjs`：表清單與 0004；`test_bridge_db_boundary.mjs`：見偏差 2。

### 新增的測試檔

`test_bridge_counters_db.mjs`（計數、視窗邊界、並行、旗標、清理、缺 0004）、`test_bridge_notify_budget.mjs`（發送預算、並行、Retry-After、重送、usage_high、隱私、缺 0004）、`test_bridge_binding_security.mjs`（新碼與舊碼、D5、D6、並行、`allow_rebind` 端點、缺 0004、隱私）；同意頁的純函式與頁面測試加在 `test_link_authorize_form.mjs`、`test_link_authorize_page.mjs`。

### 未驗證（需要真實環境）

- 真實 D1 在多區域下 `UPSERT … WHERE n < cap` 與 `changes()` 的行為（本機 Miniflare 的 SQLite 語意相同，但真實 D1 的寫入路由／重試語意未實測）。
- 真實 LINE：推給原綁定者的「綁定已被更換」是否送達（客戶若已封鎖 OA 會失敗，被吞掉）；`line.me/R/oaMessage` 預填連結帶連字號的碼是否被 LINE 客戶端原樣傳送。
- 暫停機制對真實流量的誤觸率（偏差 3）。
