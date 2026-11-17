# LM-2A 設計：授權碼流程與「已連結的產品」

狀態：**設計已確認；2A-1（後端）與 2A-2（前端）都已實作，待部署與手動遷移**（2A-3 真機實測尚未開始）。
**真實 LIFF 登入是否保留網址參數，在沙箱無法驗證**：2A-2 已用 `sessionStorage` 備援（見第 13 節 2A-2），真機驗證留給 2A-3。
已確認的決定：產品登記採選項 A（管理端點＋`BRIDGE_ADMIN_SECRET`）；重新授權＝撤銷舊連結、發新連結；
連結 scope 預設全開 `link:manage`、`contacts:bind`、`messages:send`（受產品登記的 scope 上限約束），同意頁不細分。
實作與設計的差異見第 13 節，部署後要做的事見第 14 節。範圍：讓外部產品（例如 Image Picker）經由「使用者同意」
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
| 2A-1 | 後端：遷移 0002、`db.js` 擴充、產品登記、授權碼、換金鑰、連結管理、連結金鑰認證（**程式完成，待部署**） | 合併部署後，在兩個 D1 Console 貼 0002（第 14 節） |
| 2A-2 | 前端：同意頁＋後台「已連結的產品」（**程式完成，待部署**） | 合併部署即可 |
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

## 13. 實作與設計的對照（2A-1 實作時的決定）

檔案：`migrations/0002_bridge_links.sql`、`worker_src/bridge/{links,scopes}.js`（新）、`db.js`／`auth.js`／`routes.js`／`index.js`（擴充）、
`worker_src/lm_service.js`（新增三個唯讀函式）。測試：`tests/unit/test_bridge_links.mjs`（端點，含攻擊情境）、`test_bridge_links_db.mjs`（資料層原子性）。

- **產品密鑰格式**：`bps_<12 位小寫 hex>_<32 bytes base64url>`，其中 12 位 hex 就是 `product_id`（`prd_<同 12 位>`）的尾碼。
  這樣 `links/token` 只靠 `Authorization` 就能知道「在對哪個產品猜密鑰」，限流可以在查資料庫之前先做，契約的 request body 不必多一個欄位。
  `product_id` 本來就不是祕密（出現在 authorize 網址）；真正的祕密是後面 43 字元，資料庫只存整串的 SHA-256，以常數時間比對。
- **連結金鑰的 `service_keys.system`**：寫成 `link:<link_id>`。含 `:`，而系統名稱 regex 不允許 `:`，所以不可能與任何系統撞名，
  `rotateKey`／`deleteSystem` 的 `WHERE bot_id AND system` 也不會碰到連結金鑰。
- **既有系統認證路徑的隔離**：`getKeyWithSystem` 的 SQL 加 `AND k.link_id IS NULL`，連結金鑰在 `/raw/*` 一律當作「查無金鑰」（401，與不存在同一個回應）。
  系統金鑰（`link_id` 為空）在連結端點是 `INVALID_KEY`。
- **認證順序與設計稿的小差異**：設計稿寫「金鑰未撤銷 → 連結 active」。但撤銷連結時會一併撤銷金鑰，若先檢查金鑰，
  已撤銷連結的金鑰永遠只會看到 `INVALID_KEY`，達不到「連結撤銷後立即 `LINK_REVOKED`」。所以實作是：
  查不到／系統金鑰／孤兒金鑰 → `INVALID_KEY`；**連結已撤銷 → `LINK_REVOKED`（先於金鑰撤銷檢查）**；金鑰已撤銷（例如輪替掉）→ `INVALID_KEY`；產品停用 → `LINK_REVOKED`；scope 不足 → `SCOPE_DENIED`。
  `principal.scopes` = 金鑰 ∩ 連結 ∩ 三個連結 scope：資料庫就算被寫入 `raw:push` 也不會被當成權限。
- **授權碼消耗條件**：單一 `UPDATE … WHERE code_hash=? AND product_id=? AND redirect_uri=? AND used_at IS NULL AND expires_at>?`（`meta.changes === 1` 才成功）。
  產品或 redirect_uri 不符時 UPDATE 不會命中，因此**不會燒掉合法持有人的碼**；對外仍是同一個 `INVALID_CODE`。
- **授權碼清理**：每次發碼順手刪除「過期超過 1 小時」的舊碼（`idx_auth_codes_expiry`），不另設排程。
- **同意頁用的額外資料**：`preview` 另回 `cancel_redirect_to`（已驗證過的 `redirect_uri?error=access_denied&state=…`），前端按「取消」直接導過去，不必自己組網址。
- **後台端點如何指定 bot**：`GET /admin/links`、`DELETE /admin/links/{id}` 以 `X-Bot-Id`（或 `?bot_id=`）指定 bot，再用 `getOwnedBot` 檢查 owner；不是 owner 與 bot 不存在都是 404。
- **`lm_service.js` 新增**（唯讀、不丟錯）：`getOwnedBot(env, userId, botId)`（以 `bot:{id}:permissions` 為準的 owner 檢查，回 id＋顯示名稱）、
  `listOwnedBots(env, userId)`（候選取自 `user:{id}:bots`，逐一用 `getOwnedBot` 重新驗證）、`getBotDisplayName(env, botId)`（交換授權碼時回 `bot_display_name`，此時沒有人主體）。
- **稽核**：`product_registered`（actor `system/admin_endpoint`）、`link_authorized`（actor 為按同意的使用者）、`link_revoked`（自動被重新授權取代、連結金鑰解除、後台撤銷三種都記）、
  `key_rotated`、`code_exchange_failed`（只記 `product_id` 與 `error_code`；只有「產品確實存在」才記，避免任意 id 灌爆表）。`sanitizeDetail` 新增 `product_id`（`^prd_[a-z0-9]{6,32}$`）、`link_id`（`^lnk_[a-z0-9]{6,32}$`）、`error_code`（`^[A-Z][A-Z_]{1,31}$`）。
- **限流**：`links/token` 以 `(CF-Connecting-IP, product_id)` 每分鐘 30 次（格式不合的密鑰歸入 `unknown` 桶）；`admin/products` 以 IP 每分鐘 10 次。
  沿用 `checkRateLimit`（KV）：**缺 KV binding 或 KV 出錯時 fail-open**（既有行為，未改）。
- **`BRIDGE_ALLOW_LOCALHOST_REDIRECT=1`**：只給測試／本機開發，允許登記 `http(s)://localhost|127.0.0.1|[::1]`；預設與其他任何值都不允許。正式環境不要設。
- **掛載前綴**：同意頁網址以 `env.MOUNT_PATH`（與 `worker_src/lib/mount.js` 相同的正規化規則）組成 `<MOUNT_PATH>/pages/link_authorize.html`。
  Bridge 不得 import `lib/mount.js`，所以 `links.js` 的 `mountPrefix` 複製了那幾行，並有測試釘住兩者一致。
- **不在這一張**：`pages/link_authorize.html`、後台「已連結的產品」（2A-2）；`contacts/bind-tokens`、`/messages`（LM-3）。
  停用產品目前只能直接改 D1（`UPDATE products SET disabled = 1 WHERE product_id = '…'`）；沒有 API。

### 2A-2（前端）實作對照

檔案：`pages/link_authorize.html`、`js/link_authorize.js`、`helper/link_authorize_form.js`（純函式）、`pages/system_management.html`＋`js/system_management.js`（後台區塊）。
測試：`tests/unit/test_link_authorize_form.mjs`（純函式）、`tests/unit/test_link_authorize_page.mjs`（靜態檢查）；`test_system_page.mjs` 的路徑白名單加入 `/bridge/v1/admin/links`。
另以 Playwright 在真實 Chromium 驗證（腳本放在工作目錄 scratchpad，不進 repo）。

- **LIFF 登入與參數（第 11 節風險）**：`liff.init` 之後才讀網址（LIFF 可能在這一步還原原始查詢字串）；網址三個參數都在就用網址並清掉備援，否則用 `sessionStorage` 還原並**立即清掉**；
  都沒有就顯示錯誤並停止（不呼叫 API、不導向、也不呼叫 `liff.login`）。未登入時先把參數存進 `sessionStorage` 再 `liff.login()`。所有 storage 存取都有 try/catch，沒有 storage 時頁面仍可運作（登入後參數若遺失，要回產品重新開始）。
  **「真實 LIFF 登入後網址是否保留參數」無法在沙箱驗證**（Playwright 用的是 stub：登入後把網址導回不帶查詢字串的版本，以此模擬最壞情況，備援可還原）。2A-3 真機要確認：登入回來時 `liff.init` 後的 `location.search` 是否完整；若 LIFF 的 endpoint URL 設定與同意頁路徑不一致，也要在這時檢查。
- **防點擊劫持**：`<head>` 的行內 script 在任何內容渲染前就檢查 `window.top !== window.self` 並標記 `framed`（CSS 隱藏卡片）；`link_authorize.js` 的 `init()` 再檢查一次，被嵌入時移除卡片並直接返回（不呼叫 `liff`、不呼叫 API）。只顯示「請在瀏覽器直接開啟此頁面。」（設計稿第 11 節「是否另加 header」仍未做，見下方缺口。）
- **其他隱私**：`<meta name="referrer" content="no-referrer">`、`noindex`；頁面不印任何 console（靜態測試釘住）；導向用 `location.replace`，返回鍵不會回到同意頁。
- **導向驗證**（`validateRedirectTarget`）：`redirect_to`（同意）與 `cancel_redirect_to`（取消）導向前都要通過：能解析、協定 `https:`、無帳號密碼、無 fragment、不含空白／控制字元、`origin + pathname` 與網址上的原 `redirect_uri` 完全相同；任何一項不符就不導向並顯示錯誤（同意）／提示（取消）。
  唯一會離開頁面的程式碼是 `navigate()`，靜態測試釘住只有一處 `location.replace`。
- **畫面**：產品名稱與 bot 名稱一律 `textContent`；scope 轉中文，**不認識的 scope（含 `raw:push`）顯示「未知權限」、不顯示原字串，並停用「同意」**；scope 為空陣列也停用。
  bot：1 個預選；多個用 `<select>`（預設「請選擇」，未選時同意停用，不替使用者挑）；0 個顯示「你沒有可授權的官方帳號（需為管理員）」且同意停用（仍可取消）。按下任一按鈕立即 disabled，approve 失敗才恢復。
- **錯誤處理**：同意頁與後台都自己解析 `{error:{code}}`（`describeLinkError`），只依 code 與 HTTP status 對照中文，不顯示後端 message；`ErrorHandler` 只認 400/401/403/404/500，所以走 `rawResponse` + `showErrorToast:false`。
- **後台**：`GET /bridge/v1/admin/links`、`DELETE /bridge/v1/admin/links/{link_id}` 以 `X-Bot-Id`（目前專案，取自 `/team/members`）指定 bot；撤銷前用 `showConfirm`（它會逸出標題與訊息）說明「撤銷後該產品立即無法再使用，需重新授權才能恢復」，成功後重新載入。
  列表：使用中在前、各組新到舊。`loadLinks()` **不被 `await`**，且自己吞掉所有錯誤：連結 API 很慢或失敗，不會拖住全頁載入遮罩，也不影響系統列表。
- **認證與本機開發**：認證仍是 `ApiClient` 自動帶的 LIFF `Authorization`（本機開發另帶 `X-User-Id`）；同意頁沒有「debug 模擬登入」捷徑（`invite.html` 有，這裡刻意不做：授權頁不該有繞過登入的路徑），本機測試請用 LIFF stub 或有效的 dev 設定。
- **發現的缺口（未改後端）**：`/pages/link_authorize.html` 是 Worker 以靜態檔提供的，沒有 `X-Frame-Options: DENY`／`Content-Security-Policy: frame-ancestors 'none'`；目前只靠頁面內的 `top === self` 檢查（JS 被停用的瀏覽器理論上可被嵌入，但此時頁面也無法登入與送出）。建議之後在 Worker 對這個路徑補 header（後端範圍，本次未動）。

## 14. 操作手冊（部署後由人執行）

合併部署後 Bridge 仍是關閉的（`BRIDGE_ENABLED` 未設）。遷移與 secret 都就緒之後才開旗標。

**(a) 套用遷移 0002（兩個資料庫各一次）**：Cloudflare 控制台 → Storage & Databases → D1 → `bridge-db` → **Console**，
貼上 `migrations/0002_bridge_links.sql` 的**全部內容**並執行；再對 `bridge-db-dev` 重複一次。
`ALTER TABLE service_keys ADD COLUMN link_id` **不可重複執行**：同一份檔案每個資料庫只貼一次。
萬一貼了第二次，第一句 `CREATE TABLE products` 就會因為「already exists」失敗，不會破壞既有資料；
若是只貼到一半失敗，請先用 (b) 檢查已建立了哪些表，只補貼缺的敘述（不要整份重貼）。

**(b) 驗證**：同一個 Console 執行

```sql
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```

預期比 LM-1B 多出 `auth_codes`、`links`、`products`，總共 `audit_log`、`auth_codes`、`idempotency`、`links`、`products`、`service_keys`、`systems`
（可能另有 `sqlite_sequence`，正常）。再確認欄位：`SELECT link_id FROM service_keys LIMIT 1;` 不報錯（可能是空結果）。

**(c) 設定營運密鑰 `BRIDGE_ADMIN_SECRET`**（Worker Secret，不是 Variable）：產生一串夠長的隨機值（例如 `openssl rand -base64 32`），
用 `npx wrangler secret put BRIDGE_ADMIN_SECRET`（dev 環境加 `--env dev`），或在 Cloudflare 控制台 → Workers → 該 Worker → Settings → Variables and Secrets 新增型別 **Secret**。
不要寫進 `wrangler.jsonc`、文件或任何會 commit 的檔案。**未設定時 `POST /bridge/v1/admin/products` 一律回 404。**

**(d) 開旗標**：確認 (a)(b)(c) 無誤後，把 `BRIDGE_ENABLED` 設為 `1`；`GET /bridge/v1/health` 回 `{"ok":true}`。

**(e) 登記產品**（範例只有佔位符，請自行填入；回應的 `product_secret` 只會出現這一次，立刻交給對方保管）：

```bash
curl -sS -X POST "https://<你的網域>/lm/bridge/v1/admin/products" \
  -H "Authorization: Bearer <BRIDGE_ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "<產品名稱，同意頁會顯示>",
        "redirect_uris": ["https://<產品網域>/<回呼路徑>"],
        "url_domains": ["<產品網域>"],
        "scopes": ["link:manage", "contacts:bind", "messages:send"]
      }'
# 201 → { "product_id": "prd_…", "product_secret": "bps_…", ... }
```

`redirect_uris` 必須是 https（不可含 `#`、帳號密碼，也不可預先帶 `code`／`state`／`error` 參數），之後與請求值**逐字元精確比對**；要換網址就是重新登記或改 D1。
`scopes` 只能是上面三個（`raw:push`、`messages:push` 一律被拒）。

**(f) 停用產品（緊急）**：D1 Console 執行 `UPDATE products SET disabled = 1 WHERE product_id = '<prd_…>';`
立即生效：新的授權、換碼都被拒，既有連結金鑰回 `LINK_REVOKED`。恢復改回 `0`。

**(g) 排錯**：`GET /bridge/v1/health` 回 503 `bridge_not_configured` → 缺 `BRIDGE_DB` 綁定或缺表（回到 (a)(b)）。
稽核可在 Console 查：`SELECT at, action, result, bot_id, detail FROM audit_log WHERE action IN ('product_registered','link_authorized','link_revoked','key_rotated','code_exchange_failed') ORDER BY id DESC LIMIT 50;`
