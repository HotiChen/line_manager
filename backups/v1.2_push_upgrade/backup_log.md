# 版本備份日誌 - v1.2 (訊息發送模組大升級)
**備份時間**：2026-01-05 01:21
**備份目錄**：`backups/v1.2_push_upgrade/`

## 更新摘要
本次更新對「分眾訊息發送」模組進行了徹底的重構，使其功能與「關鍵字回覆」同步，具備強大的分眾與組合發送能力。

## 詳細變更內容

### 1. 前端 UI 升級 (`pages/message_push.html`)
- **多重訊息模式**：將原本單一的文字框替換為可動態新增的訊息列表（與關鍵字回覆介面一致）。
- **訊息類型支援**：整合了 `message.helper.js`，支援在單次發送中混搭文字、Flex Message 與 Imagemap 圖卡。
- **發送上限控制**：實作了單次發送最多 5 則訊息的限制與計數器。
- **篩選器優化**：新增了「全選所有」與「全部清除」的全域操作按鈕，優化了分眾選擇流程。

### 2. 前端邏輯重構 (`js/message_push.js`)
- **狀態管理**：新增 `currentPushMessages` 陣列管理已加入的訊息。
- **資料連動**：在初始化時自動載入使用者的 Flex 與 Imagemap 範本庫。
- **格式轉換**：新增 `convertToLineFormat` 函式，將內部的訊息物件正確封裝為 LINE API 所需的 JSON 格式。
- **發送流程最佳化**：更新 `startSendingProcess` 支援批次發送多則訊息。

### 3. 後端 API 增益 (`worker_src/handler/push_message.js`)
- **變數替換功能 (Variable Replacement)**：實作了 `(@name)`、`(@date)`、`(@time)`、`(@day)` 的自動替換邏輯。
- **會員資料抓取**：發送時會根據收件人的 `to` (userId) 自動從 KV 撈取最新會員 profile 來進行名字替換。
- **偵錯日誌**：加入 Imagemap `baseUrl` 之類的後端偵錯輸出資訊。

### 4. API 標準化 (`flex.js`, `imagemap.js`)
- 修復了列表讀取 API 缺少 `success: true` 導致前端讀取失敗的問題。

## 檔案備份清單
- `pages/message_push.html`
- `js/message_push.js`
- `worker_src/handler/push_message.js`
- `worker_src/handler/flex.js`
- `worker_src/handler/imagemap.js`

---
*備份完成。系統目前運行穩定，變數替換與多重訊息發送功能經測試正常。*
