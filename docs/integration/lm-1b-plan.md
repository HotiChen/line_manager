# LM-1B 設計：Bridge 專用 D1 資料庫

狀態：**已實作，待部署**。範圍：`BRIDGE_DB`（Cloudflare D1）、遷移檔、D1 測試工具，
並把 Bridge 的金鑰、系統、冪等紀錄、稽核紀錄從 KV 移到 D1。
前置：LM-1A 已上線（Bridge 已獨立在 `worker_src/bridge/`，預設關閉）。

## 1. 為什麼要換

KV 沒有原子操作。目前已知的後果（見 `lm-audit.md` 第 4 節）：

| 問題 | 現況（KV） | D1 之後 |
|---|---|---|
| 兩人同時註冊同名系統 | 各拿到一把金鑰，其中一把成為孤兒 | `PRIMARY KEY (bot_id, system)` 讓第二個直接失敗 |
| 同一個冪等鍵同時送兩次 | 讀→寫之間有競態，可能重複送 | 單一 `INSERT … ON CONFLICT`，只有一個贏 |
| 輪替金鑰到一半失敗 | 可能兩把都有效，或舊的沒被撤銷 | `batch()` 交易：全成功或全回滾 |
| 撤銷後金鑰仍短暫有效 | KV 邊緣快取最終一致 | 以資料庫為準 |
| 沒有稽核紀錄 | 只有 `console.error` | `audit_log` 表 |

**已實測驗證**（Miniflare 內的 D1，與正式 D1 同一套 SQLite 語意）：重複主鍵被拒絕；條件式更新第二次影響 0 筆；
10 個並行請求搶同一把鍵只有 1 個成功；`batch` 失敗時整批回滾。

## 2. 範圍

**移到 D1**：`systems`、`service_keys`、`idempotency`、`audit_log`。

**留在 KV**（刻意）：
- 限流計數器與額度快取：高頻寫入、可容忍近似值，放 D1 只會增加成本與延遲。
- LM 自己的所有資料（會員、關鍵字、token…）：Bridge 本來就不得直接碰。

**不在這一張**：`products`、`links`、授權碼、綁定權杖、`messages`（各自在 LM-2A／3A／3B，連同使用它們的程式一起建，避免先建一堆沒人用的表）。

**資料遷移**：不需要。Bridge 目前是關閉的，正式環境沒有發出過任何金鑰；舊的 KV 系統紀錄（若有測試殘留）直接放棄。

## 3. 結構（遷移檔 `migrations/0001_bridge_init.sql`）

```sql
CREATE TABLE systems (
  bot_id      TEXT    NOT NULL,
  system      TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  scopes      TEXT    NOT NULL,            -- JSON 陣列
  webhook_url TEXT,
  events      TEXT    NOT NULL DEFAULT '[]',
  disabled    INTEGER NOT NULL DEFAULT 0,
  rate_limit  TEXT,                        -- JSON {write, read}，可為空
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (bot_id, system)
);

CREATE TABLE service_keys (
  key_hash   TEXT    PRIMARY KEY,          -- SHA-256，不存原文
  bot_id     TEXT    NOT NULL,
  system     TEXT    NOT NULL,
  scopes     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_service_keys_system ON service_keys (bot_id, system);

CREATE TABLE idempotency (
  bot_id          TEXT    NOT NULL,
  system          TEXT    NOT NULL,
  key_hash        TEXT    NOT NULL,        -- 呼叫端冪等鍵的雜湊
  fingerprint     TEXT    NOT NULL,        -- 請求內容的雜湊，同鍵不同內容回 422
  status          TEXT    NOT NULL CHECK (status IN ('in_progress', 'done')),
  response_status INTEGER,
  response_body   TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (bot_id, system, key_hash)
);
CREATE INDEX idx_idempotency_expiry ON idempotency (expires_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor_type TEXT    NOT NULL,             -- user | service_key | system
  actor_id   TEXT,
  bot_id     TEXT,
  system     TEXT,
  action     TEXT    NOT NULL,
  result     TEXT    NOT NULL,
  detail     TEXT                          -- JSON，不含金鑰、LINE userId 全文、訊息內文
);
CREATE INDEX idx_audit_log_bot_at ON audit_log (bot_id, at);
```

刻意沒有外鍵：刪除系統時用 `batch()` 一次完成「撤銷金鑰＋刪系統」，撤銷過的金鑰紀錄保留供稽核。

## 4. 行為與不變量

- **認證**：一次查詢取得金鑰、系統與停用狀態（`LEFT JOIN`）。保留既有語意：查無金鑰或已撤銷 → 401（同一訊息）；金鑰在但系統不存在或停用 → 403。
- **冪等**：`INSERT … ON CONFLICT DO UPDATE … WHERE expires_at < now` 原子地「搶佔」；搶不到就讀既有紀錄決定回放、409 或 422。處理中紀錄 2 分鐘到期，完成紀錄 24 小時，與現行相同。
- **註冊**：`INSERT` 撞唯一約束 → 409，不再先讀後寫。
- **輪替／刪除**：`batch()` 交易。
- **稽核**（只寫「做了什麼」，不寫內容）：系統建立／修改／刪除／輪替、推播成功與失敗（錯誤碼、收件人數、額度成本）。
- **fail-closed**：缺 `BRIDGE_DB` 綁定或查詢失敗 → `503 bridge_not_configured`（被 Bridge 的例外隔離接住），**不會**退回 KV。`GET /bridge/v1/health` 開啟時會 `SELECT 1`。
- **邊界不變**：`BRIDGE_DB` 只在 `worker_src/bridge/` 內使用；LM 核心看不到它。

## 5. 測試策略

- **用 Miniflare 的真 D1**（`miniflare` 已隨 wrangler 安裝，不新增任何依賴）。測試工具套用 `migrations/` 底下**同一批** SQL 檔，結構只有一份來源。
- 啟動約 2.6 秒，只有用到 D1 的測試檔會付這個成本；每個檔案共用一個實例，測試之間清表。
- 必測的並行情境：同名系統同時註冊、同一冪等鍵 10 個並行、輪替中途失敗回滾、一次性資料只能用一次。
- `tests/unit/test_wrangler_config.mjs` 新增斷言：prod 與 dev 的 D1 `database_id` 不同；dev 不得指向正式資料庫。
- 未驗證：CI 是 Node 20，我的環境是 Node 22。Miniflare 宣告支援 `>=16.13`，但**第一次在 CI 跑會是實測**；若失敗，備案是 `better-sqlite3`（需新增 devDependency）。

## 6. 設定與部署

- `wrangler.jsonc`：頂層與 `env.dev` **各寫一份** `d1_databases`（`env.dev` 不繼承頂層）。
- **部署不需要 D1 權限**：官方文件指出部署帶有 D1 綁定的 Worker 只需要 Worker 的 Editor 權限，不需要綁定資源本身的權限。所以現有的部署 token 不用改。
- **遷移不放進自動部署**：`wrangler d1 migrations apply` 需要 D1 Edit（文件未直接寫明，是我的推論）。我選擇**不把它放進 CI**：正式資料庫的結構變更由你手動確認後套用，也避免為此擴大部署 token 的權限。
- 先部署、後套用遷移是安全的：`BRIDGE_ENABLED` 預設關閉，Bridge 不會碰資料庫。

## 7. 上線順序

1. 你建立兩個 D1 資料庫（正式、開發），把兩個 Database ID 給我（ID 不是密鑰）。
2. 我實作、測試、開 PR；PR 內含 `wrangler.jsonc` 的綁定與 `migrations/0001_bridge_init.sql`。
3. 合併部署（Bridge 仍關閉，行為不變）。
4. 你在正式資料庫的 Console 貼上遷移 SQL 並執行（開發資料庫同樣做一次）。
5. 之後需要用 Bridge 時，才設 `BRIDGE_ENABLED=1`。

## 8. 風險

| 風險 | 緩解 |
|---|---|
| Miniflare 在 CI（Node 20）跑不起來 | 第一次 PR 的 CI 即實測；備案 `better-sqlite3` |
| 遷移檔與程式不同步 | 測試工具與正式環境用同一批 SQL，沒有第二份結構 |
| 資料庫 ID 填錯、dev 指到正式 | `test_wrangler_config` 斷言兩者不同 |
| 漏套用遷移就開旗標 | 缺表會被查詢失敗接住，回 503，不會誤用 KV |
| 稽核紀錄含敏感資料 | `detail` 欄位只收白名單欄位，並有測試確認不含金鑰與 LINE userId 全文 |

## 9. 與整體計畫的關係

LM-1B 之後的 LM-1C 在這個基礎上做 `brk_` 金鑰前綴、新的錯誤格式與 `raw:push` scope 改名；
LM-2A 起才會新增 `products`、`links`、授權碼等表（各一個遷移檔）。

## 10. 操作手冊（部署後由人執行）

遷移不放進自動部署（見第 6 節）。部署這一版之後，Bridge 仍是關閉的（`BRIDGE_ENABLED` 未設），
在套用遷移之前它不會碰資料庫。

**(a) 套用遷移**：Cloudflare 控制台 → Storage & Databases → D1 → `bridge-db` → **Console**，
貼上 `migrations/0001_bridge_init.sql` 的全部內容並執行。再對 `bridge-db-dev` 重複一次。
（同一份檔案只執行一次；重複執行會因為「table already exists」失敗，不會破壞既有資料。）

**(b) 驗證**：在同一個 Console 執行

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

預期看到 `audit_log`、`idempotency`、`service_keys`、`systems`（另外可能有 `sqlite_sequence`，是 `audit_log` 的自增計數，正常）。

**(c) 最後才開旗標**：確認 (b) 無誤後，才把 Worker 的 `BRIDGE_ENABLED` 設為 `1`。
開啟後 `GET /bridge/v1/health` 會對資料庫做 `SELECT 1`：回 `200 {"ok":true}` 代表綁定與資料庫可用；
回 `503 {"success":false,"error":"bridge_not_configured"}` 代表缺綁定、缺表或資料庫不可用 —— Bridge 不會退回 KV，
請回到 (a)(b) 檢查。

之後新增遷移檔（`migrations/0002_*.sql` …）時，同樣由人逐檔貼到兩個資料庫的 Console 執行。

## 11. 實作與設計的對照（實作時的決定）

- `worker_src/bridge/db.js` 是唯一寫 SQL 的檔案，也是唯一讀 `BRIDGE_DB` 的地方（`auth.js` 只做存在性檢查）；
  `tests/unit/test_bridge_db_boundary.mjs` 把關。
- 輪替新 key 的 scopes 取自 `systems.scopes`（與註冊時寫進 key 的相同；PATCH 不能改 scopes，所以兩者永遠一致）。
- 冪等紀錄的收尾（complete／release）是盡力而為：訊息已送出後才記錄失敗，不改變回應；紀錄會在 2 分鐘後過期。
  搶佔（claim）失敗則 503，且不送訊息。
- 稽核 `detail` 白名單（`db.js` 的 `sanitizeDetail`）：`recipients`、`messages`、`cost`、`status`、`error`、`fields`、`scopes`、`disabled`。
- 測試用 Miniflare 的真 D1（`tests/helpers/mock_d1.mjs`），啟動約 2.6 秒，每個用到的測試檔一個實例。
  已在 Node 20.20 與 22 驗證可執行。

