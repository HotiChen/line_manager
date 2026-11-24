-- LM-4C：LINE 身分換 ref（binding: BRIDGE_DB）
-- 設計見 docs/integration/lm-4-plan.md 的 LM-4C 與 bridge-v1.1-draft.md §C。
-- 部署後由人在 D1 Console 對 bridge-db 與 bridge-db-dev 各貼一次整份（部署新程式之前）；
-- 未套用時，身分功能不啟用（公開端點一律回「未啟用」、營運與後台端點回 503 bridge_not_configured），不會放行。
-- 注意：這份檔案在每個資料庫只能整份貼一次（ALTER TABLE 重複套用會明確失敗）。

-- 每個 OA 一組 LINE Login channel（必須和 OA 在同一個 Provider 底下，userId 才對得上）。
-- secret_enc 是 AES-GCM 密文（enc.v1.…）；verified_at 有值才代表「LIFF 登入的 userId 對得上這個 OA 的會員」。
CREATE TABLE identity_channels (
  bot_id      TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  secret_enc  TEXT NOT NULL,
  liff_id     TEXT,
  liff_url    TEXT,
  verified_at INTEGER,
  updated_at  INTEGER NOT NULL
);

-- 一次性身分碼：只存雜湊，以及發碼當下解出的 ref／status（沒有綁定時為 NULL）。刻意不存 LINE userId。
CREATE TABLE identity_codes (
  code_hash  TEXT PRIMARY KEY,
  link_id    TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  ref        TEXT,
  status     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX idx_identity_codes_expiry ON identity_codes (expires_at);

-- 產品接收「身分碼導回」的網址（JSON 陣列，精確比對；LM 導向第一個）
ALTER TABLE products ADD COLUMN identity_return_uris TEXT;
