-- LM-2A：授權碼流程與「已連結的產品」（binding: BRIDGE_DB）
-- 設計見 docs/integration/lm-2a-plan.md 第 5 節。
-- 刻意沒有外鍵：撤銷時用 batch() 一次完成，撤銷過的紀錄保留供稽核。
-- 注意：最後的 ALTER TABLE 不可重複執行；這份檔案在每個資料庫只能整份貼一次。

CREATE TABLE products (
  product_id    TEXT PRIMARY KEY,           -- 例如 prd_xxxxxxxxxxxx
  name          TEXT NOT NULL,              -- 同意頁顯示
  secret_hash   TEXT NOT NULL,              -- SHA-256，不存原文
  redirect_uris TEXT NOT NULL,              -- JSON 陣列，精確比對
  url_domains   TEXT NOT NULL DEFAULT '[]', -- LM-3B 的 action.url 白名單
  scopes        TEXT NOT NULL,              -- 此產品「最多」能要求的 scope（JSON 陣列）
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE links (
  link_id    TEXT PRIMARY KEY,              -- lnk_xxxxxxxxxxxxxxxx
  product_id TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  scopes     TEXT NOT NULL,                 -- 同意當下授予的 scope（JSON 陣列）
  status     TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
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
