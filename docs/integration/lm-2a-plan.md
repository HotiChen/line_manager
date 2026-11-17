# LM-2A 設計：授權碼流程與「已連結的產品」

狀態：**設計草案，待確認**（尚未實作）。範圍：讓外部產品（例如 Image Picker）經由「使用者同意」
取得一把只屬於某個 bot、權限受限的 Bridge 金鑰，並讓 owner 在後台查看與撤銷。
前置：LM-1A／1B／1C 已上線（Bridge 獨立、D1、`brk_` 金鑰、`raw:push`、錯誤格式 helper）。
契約來源：[`bridge-v1.yaml`](bridge-v1.yaml)；取捨：[`gap-analysis.md`](gap-analysis.md) D-1、D-5、D-7。

## 1. 要解決什麼

目前拿到 Bridge 金鑰的唯一方式，是 owner 在後台手動「註冊系統」再把金鑰抄給對方。
這對外部產品不可行：金鑰經人工複製、無法限定範圍到「通知客戶」、產品也無法自助重新連結。

LM-2A 之後：

1. 產品把使用者導到 LM 的同意頁。
2. owner 登入 LM、選一個 bot、看到「這個產品要求哪些權限」、按同意。
3. 產品用一次性授權碼＋自己的密鑰換到金鑰。金鑰只出現一次，且**永遠不含 `raw:push`**。
4. owner 隨時能在後台看到已連結的產品並撤銷；撤銷立即生效。

## 2. 名詞

| 名詞 | 意義 |
|---|---|
| 產品（product） | 外部應用，由 LM 營運者**事先登記**（不是任何 owner 都能自己登記，見 §4） |
| 連結（link） | 一個產品對一個 bot 的授權關係；有狀態 active／revoked |
| 授權碼（code） | 同意後產生，5 分鐘、單次使用，只能換一次金鑰 |
| 連結金鑰 | `brk_…`，綁定一條連結，scope 只含 `link:manage`、`contacts:bind`、`messages:send` |

連結與既有「系統（systems）」是**兩個獨立概念**：系統是 owner 手動發給信任對象的金鑰（可含 `raw:push`），
連結是產品經同意流程取得的受限金鑰。兩者的金鑰共用 `service_keys` 表與同一套雜湊認證。

## 3. 流程

```
產品                      瀏覽器（owner）                    LM Worker / D1
 │ 導向 /bridge/v1/link/authorize?product_id&state&redirect_uri
 │──────────────────────────▶│
 │                           │ GET authorize ─────────────▶ 驗證 product_id、redirect_uri 精確比對
 │                           │◀──── 302 /lm/pages/link_authorize.html?…（原參數）
 │                           │ 頁面經 LIFF 登入（同 invite.html 做法）
 │                           │ GET  /bridge/v1/link/authorize/preview ─▶ 回產品名稱、要求的 scope、可選 bot
 │                           │ （owner 選 bot、按同意）
 │                           │ POST /bridge/v1/link/authorize/approve ─▶ 檢查 owner 權限；產生授權碼（只存雜湊）
 │                           │◀──── { redirect_to: redirect_uri?code=…&state=… }
 │◀──────────────────────────│ 頁面導回產品
 │ POST /bridge/v1/links/token（Bearer 產品密鑰；code、redirect_uri）
 │─────────────────────────────────────────────────────────▶ 單次消耗授權碼；建立連結＋金鑰
 │◀──── { link_id, service_key, scopes, bot_display_name }
```

為什麼 GET authorize 要先轉到前端頁面：Worker 的 LIFF 認證靠 `Authorization` header，瀏覽器直接導覽不會帶，
所以「看得到使用者是誰」只能發生在前端頁面呼叫 API 的那一刻。`approve` 是人主體 API（LIFF＋owner 權限），
不是金鑰 API。

## 4. 產品登記（需你決定）

產品不能讓任意 owner 自助登記：同意頁會顯示產品名稱並請 owner 授權，登記權等於「能冒用品牌的權力」。

| 選項 | 做法 | 優點 | 缺點 |
|---|---|---|---|
| **A（建議）管理端點＋營運密鑰** | `POST /bridge/v1/admin/products`，需 Worker Secret `BRIDGE_ADMIN_SECRET`；回傳產品密鑰（只一次） | 不新增使用者角色；手機用 curl／捷徑可操作；稽核有紀錄 | 多一個 secret 要管 |
| B 直接在 D1 Console 寫 SQL | 手動 `INSERT INTO products` | 零程式 | 產品密鑰雜湊要自己算，手機上很難；沒有稽核 |
| C LM 平台管理員角色 | 後台新增「平台管理員」 | 最完整 | LM 目前沒有這一層，工作量大，MVP 不值得 |

只有 1 個產品（Image Picker）時 A 已足夠。`BRIDGE_ADMIN_SECRET` 未設定時端點一律 404（fail-closed）。

## 5. 資料結構（遷移 `migrations/0002_bridge_links.sql`）

```sql
CREATE TABLE products (
  product_id    TEXT PRIMARY KEY,           -- 例如 prd_xxxxxxxx
  name          TEXT NOT NULL,              -- 同意頁顯示
  secret_hash   TEXT NOT NULL,              -- SHA-256，不存原文
  redirect_uris TEXT NOT NULL,              -- JSON 陣列，精確比對
  url_domains   TEXT NOT NULL DEFAULT '[]', -- LM-3B 的 action.url 白名單
  scopes        TEXT NOT NULL,              -- 此產品「最多」能要求的 scope
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE links (
  link_id    TEXT PRIMARY KEY,              -- lnk_xxxxxxxx
  product_id TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  scopes     TEXT NOT NULL,                 -- 同意當下授予的 scope
  status     TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_by TEXT NOT NULL,                 -- 按同意的 LM 使用者
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
-- 同一產品同一 bot 同時只能有一條 active 連結
CREATE UNIQUE INDEX uq_links_active ON links (product_id, bot_id) WHERE status = 'active';
CREATE INDEX idx_links_bot ON links (bot_id);

CREATE TABLE auth_codes (
  code_hash    TEXT PRIMARY KEY,            -- SHA-256；原文只存在於導回網址
  product_id   TEXT NOT NULL,
  bot_id       TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);
CREATE INDEX idx_auth_codes_expiry ON auth_codes (expires_at);

-- 連結金鑰與連結的關聯（系統金鑰此欄為 NULL）
ALTER TABLE service_keys ADD COLUMN link_id TEXT;
CREATE INDEX idx_service_keys_link ON service_keys (link_id);
```

沒有外鍵，理由同 LM-1B：撤銷時用 `batch()` 一次完成，稽核紀錄保留。
**這一版遷移要手動套用**（兩個資料庫各一次，流程同 LM-1B 的操作手冊）；`ALTER TABLE` 不可重複執行，
所以遷移檔只能整份貼一次。

## 6. 行為與不變量

- **授權碼**：256 位元隨機、只存雜湊、5 分鐘、單次。消耗用
  `UPDATE auth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>?`，
  `meta.changes === 1` 才算成功 → 並行兩次交換只有一個贏。過期、已用、不存在**回同一個** `INVALID_CODE`。
- **換金鑰**：同一個 `batch()` 內：撤銷同 (product, bot) 既有 active 連結與其金鑰 → 建立新連結 → 發新金鑰。
  失敗整批回滾，不留孤兒。重新授權＝換一條新連結，舊金鑰立即失效。
- **`redirect_uri`**：與產品登記值**精確比對**（不做前綴、不做萬用字元）；`token` 時必須與發碼時相同。
  不符一律不導回、直接顯示錯誤頁（避免 open redirect）。
- **scope 上限**：連結 scope ⊆ 產品登記的 scope ⊆ {`link:manage`, `contacts:bind`, `messages:send`}。
  **連結流程永遠不能發出 `raw:push` 或舊的 `messages:push`**（寫成測試）。
- **認證順序**（連結金鑰）：雜湊查到 → 金鑰未撤銷 → 連結 active → 產品未停用 → scope 足夠 → 資源屬於這條連結。
  一次 `LEFT JOIN` 取得（延續 LM-1B 做法）；查不到與已撤銷回同一個 `INVALID_KEY`，連結被撤銷回 `LINK_REVOKED`。
- **產品密鑰**：只用於 `links/token`；以雜湊比對；失敗不洩漏是「產品不存在」還是「密鑰錯」。
- **限流**：`links/token` 以 (來源 IP, product_id) 限流（沿用 KV 限流器），擋暴力猜碼。
- **權限**：`approve` 與後台列表／撤銷走 `withPermission(owner)`，bot 以**檢查過的 botId** 為準，
  不信任 body 的 ownerId（延續既有安全約定）。
- **錯誤格式**：本階段**所有新端點**使用 LM-1C 的 `bridgeError`（`{error:{code,message,retryable}}`）；
  `/raw/*`、`/systems*` 維持舊格式。
- **稽核**（`audit_log`，詳細欄位白名單沿用）：`product_registered`、`link_authorized`、`link_revoked`、
  `key_rotated`、`code_exchange_failed`（只記錯誤碼與 product_id，不記授權碼或密鑰）。
- **旗標**：全部在 `BRIDGE_ENABLED=1` 之後才存在；關閉時行為與現在完全相同。

## 7. 端點清單

| 端點 | 主體 | 說明 |
|---|---|---|
| `POST /bridge/v1/admin/products` | 營運密鑰 | 登記產品，回傳產品密鑰（一次） |
| `GET /bridge/v1/link/authorize` | 無（瀏覽器） | 驗證參數後 302 到同意頁 |
| `GET /bridge/v1/link/authorize/preview` | 人（LIFF） | 同意頁資料：產品名稱、scope、可選 bot |
| `POST /bridge/v1/link/authorize/approve` | 人（LIFF＋owner） | 產生授權碼，回導回網址 |
| `POST /bridge/v1/links/token` | 產品密鑰 | 授權碼換連結＋金鑰 |
| `GET /bridge/v1/links/{id}` | 連結金鑰（`link:manage`） | 連結狀態，不含金鑰 |
| `DELETE /bridge/v1/links/{id}` | 連結金鑰（`link:manage`） | 產品自己解除 |
| `POST /bridge/v1/links/{id}/rotate-key` | 連結金鑰（`link:manage`） | 只能換自己這條 |
| `GET /bridge/v1/admin/links` | 人（owner） | 後台：此 bot 的已連結產品 |
| `DELETE /bridge/v1/admin/links/{id}` | 人（owner） | 後台撤銷 |

「金鑰不能發金鑰」維持：連結金鑰能換**自己這條**連結的金鑰，不能建立其他連結、系統或產品。

## 8. 前端

- 新增 `pages/link_authorize.html` ＋ `js/link_authorize.js`（同意頁；仿 `invite.html`：獨立頁、LIFF、查詢參數）。
- 後台「系統整合」頁新增「已連結的產品」區塊（列表、撤銷、狀態、連結時間）。
- 全部沿用 `setInnerHTML`、`escapeHTML`；**產品名稱屬外部輸入，必須轉義**（寫測試）。
- 同意頁顯示：產品名稱、要連結的 bot、白話的權限說明、只有「同意」「取消」兩個按鈕；
  取消也導回 `redirect_uri?error=access_denied&state=…`。

## 9. 測試策略

- 全部用 Miniflare D1（`tests/helpers/mock_d1.mjs`，自動套用 `migrations/` 全部檔案，包括 0002）。
- 必測的並行／攻擊情境：同一授權碼並行交換只有 1 個成功；過期碼；已用碼；`redirect_uri` 差一個字元；
  跨 bot（用 A bot 的連結金鑰存取 B bot）；產品停用；連結撤銷後金鑰立即 `LINK_REVOKED`；
  連結金鑰嘗試呼叫 `/raw/*` 與 `/systems*` 被拒；scope 越權；舊 `messages:push` 無法經連結流程取得。
- 稽核與回應掃描：不含授權碼、金鑰、金鑰雜湊、產品密鑰。
- 契約測試（LM-1D）把 `bridge-v1.yaml` 與實作對齊，不在這一張。
- 驗證不過的備案：與 LM-1B 相同，先在 PR 的 CI 實測。

## 10. 工作切分與上線順序

| 步 | 內容 | 你要做的事 |
|---|---|---|
| 2A-1 | 後端：遷移 0002、`db.js` 擴充、產品登記、授權碼、換金鑰、連結管理、連結金鑰認證 | 合併部署後，在兩個 D1 Console 貼 0002 |
| 2A-2 | 前端：同意頁＋後台「已連結的產品」 | 合併部署即可 |
| 2A-3 | 真機實測：用 curl 走完整流程 | 設 `BRIDGE_ENABLED=1`、`BRIDGE_ADMIN_SECRET`，登記一個測試產品 |

兩個 PR 分開，2A-1 先。2A-1 部署後 Bridge 仍可保持關閉，所以先部署再遷移同樣安全
（缺表只會讓 Bridge 回 503，不影響 LM）。

## 11. 風險與待確認

| 項目 | 說明 | 處理 |
|---|---|---|
| LIFF 登入後是否保留查詢參數 | 同意頁要在登入後仍拿得到 `state`、`redirect_uri` | **2A-2 第一步實測**；失敗就把參數先存 `sessionStorage` 再登入 |
| 產品登記方式 | §4 需你選 A／B／C | **請你決定**（建議 A） |
| 重新授權語意 | 目前設計為「撤銷舊連結、發新連結」 | 若你希望保留 `link_id`、只換金鑰，請告訴我 |
| `redirect_uri` 清單 | Image Picker 的回呼網址需事先知道 | 私有 repo 側提供；LM 側只登記字串 |
| 點擊劫持 | 同意頁可能被嵌入 iframe 誘導按同意 | 頁面內以 `top === self` 檢查，不符就拒絕渲染；是否另加 header 看 Worker 對靜態檔的處理 |
| `ALTER TABLE` 不可重複 | 遷移 0002 貼兩次會失敗 | 操作手冊明寫；失敗不會破壞資料 |
| 規格欄位名 | 規格為 `service_key`／`link_id`（snake_case），舊 systems API 是 `apiKey` | 新端點一律 snake_case；舊的不動 |

## 12. 需要你確認的事

1. §4 產品登記：**選 A**（管理端點＋營運密鑰）？
2. 重新授權：**撤銷舊連結、發新連結**，可以嗎？
3. 權限預設：連結預設 scope 為 `link:manage`、`contacts:bind`、`messages:send` 全開，同意頁不給 owner 單獨取消某一項，可以嗎？（簡化 MVP；之後要細分再加）
