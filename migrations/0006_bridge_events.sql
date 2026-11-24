-- LM-4B：事件轉發（binding: BRIDGE_DB）
-- 設計見 docs/integration/lm-4-plan.md 的 LM-4B 與 bridge-v1.1-draft.md §B、§0.2。
-- 部署後由人在 D1 Console 對 bridge-db 與 bridge-db-dev 各貼一次整份（部署新程式之前）；
-- 未套用時，事件轉發不啟動（不轉發、不回覆），營運與後台端點回 503 bridge_not_configured（fail-closed）。
-- 注意：這份檔案在每個資料庫只能整份貼一次（ALTER TABLE 重複套用會明確失敗）。

-- 產品接收事件的網址（https，主機必須在 url_domains 內）
ALTER TABLE products ADD COLUMN event_url TEXT;
-- 簽章密鑰（AES-GCM 密文 enc.v1.…；HMAC 需要取回明文，所以不能只存雜湊）
ALTER TABLE products ADD COLUMN event_secret_enc TEXT;

-- 產品無法即時回應時送給客人的備用內容：依 OA × product_key × action 設定，格式同 Notification（JSON）
CREATE TABLE event_fallbacks (
  bot_id      TEXT NOT NULL,
  product_key TEXT NOT NULL,
  action      TEXT NOT NULL,
  content     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (bot_id, product_key, action)
);
