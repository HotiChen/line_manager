-- LM-1B：Bridge 專用 D1 資料庫（binding: BRIDGE_DB）
-- 設計見 docs/integration/lm-1b-plan.md 第 3 節。
-- 刻意沒有外鍵：刪除系統時用 batch() 一次完成「撤銷金鑰＋刪系統」，撤銷過的金鑰紀錄保留供稽核。

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
