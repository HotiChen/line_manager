-- M-01／M-02：原子計數、暫停旗標、綁定碼的覆蓋許可（binding: BRIDGE_DB）
-- 設計見 docs/integration/lm-sec-plan.md 第 2 節。
-- 部署後由人在 D1 Console 對 bridge-db 與 bridge-db-dev 各貼一次整份（BRIDGE_ENABLED=1 之前）；
-- 未套用時，發送訊息與綁定會 fail-closed（503 bridge_not_configured），不會放行。
-- 注意：這份檔案在每個資料庫只能整份貼一次（重複套用會明確失敗，不會默默略過）。

-- 原子計數：scope_key 例 'send:min:{link}'、'send:hour:{link}:{refhash}'、'send:day:{link}'、'bindfail:{bot}'、'binduser:{bot}:{userhash}'
-- ref 與 LINE userId 只以 SHA-256 前 32 碼出現在 scope_key，不存明文
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

-- 覆蓋既有綁定的許可（預設拒絕）
ALTER TABLE bind_codes ADD COLUMN allow_rebind INTEGER NOT NULL DEFAULT 0;
