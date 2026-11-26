# LM-5A：產品申報動作清單（Rich Menu 按鈕改成下拉選單）

- 狀態：**草案，待 Tim 決定要不要做**，2026-11-26
- 相關：`adr-001-lm-product-boundary.md`（分工）、`bridge-v1.1-draft.md`（`px:` postback）、`lm-product-feature-map.md`（§2 六種接法）、`lm-4-plan.md`（LM-4A／4B）
- 前置：LM-4A（postback 分流）與 LM-4B（事件轉發）已上線

## 1. 問題

Rich Menu 要接產品的功能時，攝影師得在「訊息回傳」欄位**手打** `px:ip:status`。三個後果：

1. 攝影師看不懂那串字是什麼，也不知道有哪些可以填。
2. **打錯不會報錯**：LM 照樣把 `px:ip:statsu` 轉給產品，產品不認，就靜默走備用訊息。症狀是「按了沒反應」，查起來很花時間。
3. 備用訊息要另外在「系統整合 → 已連結的產品 → 備用訊息」逐一設好，和按鈕是分開的兩件事，容易漏。

直覺的解法是在 LM 的 Rich Menu 編輯器寫死一個下拉選單（「Image Picker → 查我的進度」）。**但那樣每接一個新產品就要改 LM**，違反 ADR-001 §3 的「新功能大多只需要在產品新增一個 `px:` 動作的處理，LM 和契約都不用改」。

## 2. 決定

**選單由產品自己申報。** 產品在登記／更新時交給 LM 一份動作清單，LM 的 Rich Menu 編輯器把它渲染成下拉選單，在背後組出 `px:<product_key>:<key>`。

接第二個產品時 **LM 一行都不用改**：它登記時申報自己的 actions，選單自動多一層。

## 3. 契約變更（只增，不改）

`POST /bridge/v1/admin/products` 與 `PATCH /bridge/v1/admin/products/{product_id}` 各多一個**選填**欄位 `actions`：

```json
{
  "actions": [
    { "key": "plans",  "label": "方案與價目", "hint": "回方案摘要與連結", "fallback": "方案請見官網：…" },
    { "key": "status", "label": "查我的進度", "hint": "需要客人已綁定" }
  ]
}
```

| 欄位 | 規則 |
|---|---|
| `key` | 必填，`^[a-z][a-z0-9_]{0,23}$`。組出來的是 `px:<product_key>:<key>` |
| `label` | 必填，1–20 字元，無控制字元。**攝影師在 LM 後台看到的就是這個** |
| `hint` | 選填，0–60 字元。選單下方的說明 |
| `fallback` | 選填，0–300 字元。建立按鈕時用來預填備用訊息；不是最終值，攝影師可改 |
| 整份 | 0–20 筆，`key` 不可重複。產品沒有 `product_key` 時 `actions` 一律拒絕（組不出 `px:` 前綴） |

### 3.1 為什麼 `actions` 可以整份覆寫

`scopes` 與 `url_domains` 是**權限**，縮小會讓既有設定失效，所以只增不減。`actions` 只是**後台 UI 的清單**，不是權限：

- 拿掉一筆 action，既有 Rich Menu 按鈕仍然送出 `px:ip:status`；產品不再處理它 → 走備用訊息。退化是溫和的，不會洩漏也不會卡住。
- 所以 `actions` 用整份覆寫（`PATCH` 給了就取代，沒給就不動）。

### 3.2 `label`／`hint`／`fallback` 是外部輸入

這三個欄位由產品提供，會顯示在 LM 的後台畫面上。**當不可信資料處理**：

- 後端：長度與控制字元檢查，存進 D1 前不做任何 HTML 處理（存原文）。
- 前端：一律走 `helper/security.js` 的 `setInnerHTML`，不可新增裸 `innerHTML` 賦值（CLAUDE.md 安全約定）。
- 不接受 URL 或 markup；`label` 只當純文字渲染。

## 4. D1 遷移

`migrations/0008_bridge_product_actions.sql`：

```sql
ALTER TABLE products ADD COLUMN actions TEXT;
```

- JSON 陣列的字串，`NULL` ＝ 沒申報（選單只剩「自己輸入」那一項，行為與現在相同）。
- 不需要 index：只在以 `product_id` 或 `product_key` 取單筆產品時一起讀出來。
- 未套用時 `actions` 一律讀成 `null`，整個功能自然不啟用（fail-closed，不影響既有行為）。

## 5. 程式改動範圍

| 檔案 | 改什麼 |
|---|---|
| `worker_src/bridge/db.js` | `products` 的三處 `SELECT`（`getProduct`、`getProductByKey`、`listLinksForBot`）加 `actions` 欄；`rowToProduct` 解析 JSON，壞掉就當 `null`；`createProduct`／`updateProduct` 寫入 |
| `worker_src/bridge/links.js` | `handleCreateProduct`／`handleUpdateProduct` 驗證並接受 `actions`；`handleAdminList`（後台「已連結的產品」用的那支）在每筆 link 回 `actions` |
| `worker_src/bridge/content.js` | 不動。`actions` 不經過通知內容的驗證路徑 |
| `js/richmenu.js` | postback 動作的欄位改成兩層下拉（產品 → 動作）＋「自己輸入」的退路；選了動作就組出 `px:<product_key>:<key>`，並用 `fallback` 預填備用訊息 |
| `docs/integration/bridge-v1.yaml` | 補 `actions` 的 schema 與兩個端點的 request body（CLAUDE.md：改 Bridge 端點要一併更新） |

**存檔時的檢查**（這是第 2 個後果的解法）：Rich Menu 存檔時，若 postback data 以 `px:` 開頭，比對前綴的 `product_key` 存在、且 `key` 在該產品申報的 `actions` 內；不符就擋下並說明。產品沒申報 `actions` 時不檢查（維持現狀）。

## 6. 測試（先寫測試再改）

| 測試檔 | 要蓋到 |
|---|---|
| `tests/unit/test_bridge_products.mjs`（新增或擴充） | `actions` 的每條驗證規則；沒有 `product_key` 時被拒；整份覆寫；`PATCH` 不給就不動；20 筆上限；`key` 重複 |
| `tests/unit/test_bridge_db_boundary.mjs` | 既有邊界測試不可退步（SQL 只在 `db.js`） |
| `tests/unit/test_bridge_contract_*.mjs` | 契約測試比對 `bridge-v1.yaml` 與真實回應（做法見 `gap-analysis.md`「契約測試」） |
| 遷移未套用的情境 | `actions` 讀成 `null`、端點不報錯、行為與現在相同 |

需要 D1 的測試用 `tests/helpers/mock_d1.mjs`（會自動套用 `migrations/*.sql`）。

## 7. Tim 要做的

1. 決定要不要做（見第 8 節的取捨）。
2. 實作合併、部署**之後**，在 D1 Console 對 **`bridge-db`** 與 **`bridge-db-dev`** 各貼一次第 4 節那一句 SQL（先貼再部署的順序：這一句是純新增欄位，先貼後部署都安全，但照既有慣例先貼）。
3. 用 `BRIDGE_ADMIN_SECRET` 對 IP 的產品 `PATCH` 一次 `actions`，內容先用 `plans` 與 `status` 兩筆。

## 8. 取捨（給決定用）

**好處**
- 攝影師看到人話，不是 `px:ip:status`。
- 打錯字在存檔時就被擋掉，不再是「按了沒反應」。
- 按鈕與備用訊息從兩件事變成一件事。
- 接第二個產品不必改 LM。

**代價**
- 一個遷移、一個選填契約欄位、一支前端編輯器的 UI。
- 產品提供的文字會出現在 LM 後台，多一處外部輸入要當不可信資料處理。
- 攝影師還是得自己決定要放哪幾顆按鈕 —— 這一步省不掉。

**不做這個的話**：現狀可以繼續用，只有一位產品、一位攝影師時痛感不大。痛感會在「第二個產品」或「攝影師自己設選單」時出現。

## 9. 明確不做

- 不在 LM 寫死任何產品的動作清單。
- `actions` 不影響權限：它不是 scope，不決定產品能不能被轉發事件（那是 `events:receive` 與 `event_url`）。
- 不讓產品透過 `actions` 提供 URL 或 HTML。
- 不自動把 action 加進攝影師的 Rich Menu —— 只提供選單，版面仍由人決定。
