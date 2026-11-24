# LM-4 開工計畫：Bridge v1.1(LM 這一側)

- 狀態：**可以開工**(Tim, 2026-11-24)。尚未有任何程式碼。
- 依據：`adr-001-lm-product-boundary.md`(分工)、`bridge-v1.1-draft.md`(契約草案 A–D)、`lm-product-feature-map.md`(各 LINE 功能放哪)
- 給設計師的對照網頁：https://claude.ai/artifact/VxujekYmTpKW1v8tnkVwvn(私人頁面，由 Tim 分享)
- 產品端(Image Picker)的對應工單在 `imge_picker` repo：`docs/line-v1.1.md`

## 0. 開工前先讀

1. `CLAUDE.md` 的 TDD 與安全約定(本計畫不重複)。B、C、D 屬於架構／安全改動，**先進 plan mode**。
2. 契約規則：草案的端點**實作完成才搬進** `bridge-v1.yaml`(契約測試會比對真實回應)；搬入時 `info.version` 升為 `1.1.0`，每張工單各自更新該檔對應的部分，並加上 `x-status: implemented`。v1 的任何端點、欄位、錯誤碼**都不能改**。
3. 邊界測試照舊要綠：`test_import_boundary`、`test_bridge_db_boundary`(SQL 只寫在 `bridge/db.js`；LINE userId 不進任何回應、稽核或 log)。
4. 新的 D1 遷移從 `0005_` 開始，放 `migrations/`，部署後由 Tim 在 D1 Console 手動套用；遷移未套用時要 fail-closed(回 `503 bridge_not_configured`，不放行)。

## 1. 工單與順序

| 工單 | 內容 | 風險 | 相依 | 可否現在開工 |
|---|---|---|---|---|
| **LM-4A** | postback 分流(`lm:`／`px:`／無前綴)、拿掉原始字串回覆 | 低 | 無 | ✅ |
| **LM-4R** | Rich Menu 規則統一(標籤規則＋產品分眾，`tier` 不再綁 Rich Menu) | 中 | 無 | ✅(要先確認正式資料，見 4R) |
| **LM-4D** | 客人分眾 API(`PUT /contacts/{ref}/segment`) | 中 | 4R | ✅ |
| **LM-4B** | 事件轉發(同步回覆、簽章、備用內容) | 高 | 4A | ✅(預設值見草案 Q2–Q5) |
| **LM-4C** | LINE Login channel 設定、LIFF 自動建立、身分換 ref | 高 | 無 | ⚠️ 先查證 LINE 文件(草案 §C.4 標為未驗證) |

建議順序：4A → 4R → 4D → 4B → 4C。每張工單一個分支、一個 PR。

---

### LM-4A　postback 分流
- **範圍**：`worker_src/lib/event_handler.js` 的 `handlePostbackEvent`。新增一個純函式模組(例如 `worker_src/lib/postback_route.js`)負責解析 data，依草案 §A.1 回傳 `{kind: 'lm'|'px'|'legacy'|'invalid', action, params, productKey}`。
- **行為**
  - `lm:reply?key=<k>`：回 LM 關鍵字回覆中 key 為 `<k>` 的內容(重用關鍵字回覆的組訊息程式，不另存一份)；找不到 key → 不回覆，記稽核。
  - `lm:menu?tab=<t>`：切換到該分頁(用 Rich Menu alias；沒有對應 → 不回覆)。
  - `px:…`：本工單**只解析、不轉發**；回草案 §B.4 的備用內容(若已設定)或不回覆。轉發在 4B 才接上。
  - 無前綴：保留 `tag=`／`untag=`；**拿掉「✅ 已收到您的操作：<data>」這句回覆**。
  - 格式不合：不回覆、不轉發，記稽核原因碼。
- **測試**(`tests/unit/test_postback_route.mjs`、`test_event_handler_postback.mjs`)：合法格式；`action`／query 長度與數量上限；300 字元上限；未知前綴；`lm:reply` 命中與未命中；舊的 `tag=` 行為不變；**任何情況都不再回原始 data**。
- **驗收**：真機按 Rich Menu 的 `lm:reply` 按鈕會回對應內容；舊的標籤按鈕仍能貼標籤；聊天室不再出現「已收到您的操作」。

### LM-4R　Rich Menu 規則統一
- **問題**：現在有兩套機制都會呼叫 `linkRichMenuToUser`：`segmented_richmenu_logic.js` 的標籤規則，和 `tier_system.js` 的 `applyTierRichMenu`(由 `member.js`、`tier.js`、等級自動升級觸發)。後執行的蓋掉先執行的。
- **做法**
  - 規則表(`segmentedRichMenuRules`)擴充比對條件：`{match: {tag: "owner"}}` 或 `{match: {segment: "ip:vip"}}`(產品分眾，4D 寫入)，加上 `priority` 和 `richMenuId`。舊格式 `{tag, richMenuId, priority}` 讀取時視為 `{match: {tag}}`(相容，不改既有資料)。
  - 所有會改變結果的時機(標籤變更、分眾變更、加好友、綁定或解除綁定)都呼叫同一個「重新計算這位好友的 Rich Menu」函式。
  - `tier` 不再直接切換 Rich Menu；等級要影響選單時，改成「等級變更 → 自動貼對應標籤」。
- **開工前要 Tim 確認**：正式環境有沒有任何 tier 設了 `richMenuId`。有的話，先把它轉成標籤規則再上線，避免使用者的選單突然變回預設。
- **測試**：優先順序(多條規則同時符合)；舊格式相容；沒有符合任何規則 → 解除個人選單、回到預設；`tier` 變更不再呼叫 `linkRichMenuToUser`。
- **Tim 的目標設定**(上線後在後台設)：`owner` → RM C、`photographer` → RM D、`ip:vip` → RM A、預設 → RM B；優先順序 C > D > A > B。

### LM-4D　客人分眾 API
- **範圍**：草案 §D。`worker_src/bridge/contacts.js`(或新檔 `segments.js`)、`bridge/routes.js`、`bridge/db.js`、`bridge/scopes.js`(加 `segments:write`)、遷移 `0005`(contacts 加 `segment` 欄位，或獨立表；以 append-only 為原則)。
- **行為**：見草案 §D.2–D.3；分眾變更後呼叫 4R 的重新計算(在 `ctx.waitUntil` 裡做，LINE API 失敗要重試，不讓 `PUT` 失敗)。解除綁定、封鎖、連結撤銷或被取代時清除分眾並重新計算。
- **後台**：對應表設定 UI(OA × product_key × segment → Rich Menu)；前端不新增裸 `innerHTML`。
- **測試**：冪等；未綁定／封鎖／不存在的 ref；scope 不足；限流；清除時機；回應與稽核不含 userId、Rich Menu id。契約：搬進 `bridge-v1.yaml`，並在 `GET /contacts/{ref}` 加 `segment` 欄位。

### LM-4B　事件轉發
- **範圍**：草案 §B 與 §0.2。產品登記新增 `product_key`、`event_url`、回傳一次性的 `event_signing_secret`(只存雜湊或加密，比照其他密鑰)；`events:receive` scope；轉發模組(例如 `worker_src/bridge/events.js`)；備用內容設定(資料與後台 UI，依 OA × product_key × action)；稽核。
- **行為重點**：先回 LINE webhook `200`，轉發與 reply 在 `ctx.waitUntil` 內；`AbortController` 實作 2500 毫秒逾時(`BRIDGE_EVENT_TIMEOUT_MS`，500–5000)，逾時後丟棄晚到的回應、絕不 push 補送；依 `webhookEventId` 去重；每位使用者每條連結每分鐘 10 次；產品回應用 `/messages` 相同的驗證與 Flex 範本。
- **測試**：轉發條件逐條；簽章格式與時間戳；逾時中止；`204`；非 JSON、超過 4 KB、驗證失敗都改送備用內容；`contact` 只在已綁定時出現；去重；限流；送給產品的本文和稽核都不含 userId、replyToken、原始 data。
- **安全審查**：上線前做一次(對外呼叫、新密鑰)。

### LM-4C　LINE 身分換 ref
- **開工前**：查證 LINE 官方文件：LINE Login channel 的 access token API、LIFF Server API(`/liff/v1/apps`)、所需權限、每個 channel 的 LIFF 數量上限、如何確認 channel 和 OA 屬於同一個 Provider。結果寫回草案 §C.4，拿掉「未驗證」標記。
- **範圍**：OA 設定頁新增 LINE Login channel ID 與 secret(加密保存，比照 OA token)；自動建立 LIFF(冪等)；LIFF 頁 `/bridge/identity`；`lmi_` 身分碼(比照 `lmc_` 的雜湊、單次、60 秒)；`POST /bridge/v1/identity/token`；`identity:read` scope；產品登記新增 `identity_return_uris`。
- **測試**：ID token 驗證失敗；身分碼單次、過期、跨連結使用；連結撤銷；`contact = null`；`to` 路徑格式；回應與 log 不含 userId。
- **安全審查**：上線前做一次(身分)。

## 2. Tim 要做的
- 4R 開工前：確認正式環境的 tier 是否綁了 Rich Menu。
- 每張工單合併後：在 D1 Console 套用該工單的遷移(會在 PR 說明寫清楚)。
- 4B／4C／4D 上線後：重新登記 IP 產品(補 `product_key = ip`、`event_url`、`identity_return_uris`、新 scope)，把新的 `event_signing_secret` 用安全管道交給 IP；在 IP 按「重新連結」讓攝影師同意新權限。
- 4C：在自己 OA 的 Provider 底下建立 LINE Login channel，把 channel ID 和 secret 填進 LM。
- 後台設定：Rich Menu 規則(4R)、分眾對應表(4D)、每個 `px:ip:` 動作的備用內容(4B)。
