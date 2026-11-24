-- LM-4D：客人分眾與產品的 product_key（binding: BRIDGE_DB）
-- 設計見 docs/integration/lm-4-plan.md 的 LM-4D 與 bridge-v1.1-draft.md §D、§0.2。
-- 部署後由人在 D1 Console 對 bridge-db 與 bridge-db-dev 各貼一次整份；
-- 未套用時，分眾端點、產品 product_key 相關查詢會失敗 → 503 bridge_not_configured（fail-closed）。
-- 注意：這份檔案在每個資料庫只能整份貼一次（ALTER TABLE 重複套用會明確失敗）。

-- 每條連結 × ref 最多一個分眾；NULL = 沒有分眾。只存分眾名稱，不存 Rich Menu id。
ALTER TABLE contacts ADD COLUMN segment TEXT;

-- 產品的短代號（postback 前綴、分眾前綴，例如 ip）。登記後只能從 NULL 設一次，全域唯一。
ALTER TABLE products ADD COLUMN product_key TEXT;
CREATE UNIQUE INDEX uq_products_key ON products (product_key) WHERE product_key IS NOT NULL;
