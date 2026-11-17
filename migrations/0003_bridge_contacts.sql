-- LM-3A：聯絡人綁定（binding: BRIDGE_DB）
-- 設計見 docs/integration/lm-3a-plan.md 第 3 節。
-- 刻意沒有外鍵：連結撤銷時綁定自然失效（查詢時推導為 disabled），不逐列改寫。
-- 注意：這份檔案在每個資料庫只能整份貼一次（重複套用會明確失敗，不會默默略過）。

CREATE TABLE bind_codes (
  code_hash            TEXT PRIMARY KEY,   -- SHA-256(綁定碼)；不存明文
  link_id              TEXT NOT NULL,      -- 發碼的連結
  bot_id               TEXT NOT NULL,      -- 該連結的 bot；綁定只會在這個 OA 的 webhook 生效
  external_contact_ref TEXT NOT NULL,      -- 產品給的不透明代號
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,   -- created_at + 7 天
  used_at              INTEGER             -- 單次使用：UPDATE ... WHERE used_at IS NULL，meta.changes = 1 才算搶到
);

-- 同 (連結, ref) 再發碼時作廢舊碼、查詢 pending 狀態
CREATE INDEX idx_bind_codes_ref ON bind_codes (link_id, external_contact_ref);
CREATE INDEX idx_bind_codes_expiry ON bind_codes (expires_at);

CREATE TABLE contacts (
  link_id              TEXT NOT NULL,
  external_contact_ref TEXT NOT NULL,
  bot_id               TEXT NOT NULL,
  line_user_id         TEXT NOT NULL,      -- 只存在這張表；任何 API 回應、audit、log 都不得出現
  status               TEXT NOT NULL CHECK (status IN ('bound', 'blocked')),
  bound_at             INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (link_id, external_contact_ref)
);

-- unfollow / follow 事件：以 (bot_id, line_user_id) 找出受影響的列
CREATE INDEX idx_contacts_user ON contacts (bot_id, line_user_id);
