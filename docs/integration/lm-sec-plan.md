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

（實作完成後補）
