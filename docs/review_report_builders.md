# 🛡️ Code Audit Report (Phase 4: Builder 防護鎖)

**審查者**: `/code-reviewer`
**審查目標**: `/js/imagemap_builder.js` 與 `/js/keyword_reply_builder.js` 圖文與關鍵字編輯器。
**審查標準**: Race Condition (競態條件) 防護與 State Management，嚴格強制寫入 "Why" (為什麼要這樣寫) 與 Pre/Post-conditions JSDoc 註解。

## ✅ 審核與改寫總結
使用者行為是難以預期的。在圖文選單與關鍵字回覆編輯器中，常常牽涉了將大圖片直接打上伺服器或是批次刪除勾選元件的昂貴操作。為了打造防撞擊的前端介面，我們補強了以下機制：

### 1. 全域防連點狀態鎖 (State Locks)
如果使用者在等待上傳或是儲存時，焦慮地連續點擊送出按鈕，常常會引發重複上傳圖片造成資源浪費，或是發送兩組相同關鍵字造成 LINE 機器人無限跳針。我們加入了全域變數鎖：
- **`imagemap_builder.js`**: 
  - 新增了 `isFetchingImagemaps` 避免初始化時重複載拉取列表。
  - 新增了 `isUploadingImagemap` 防止使用者在圖片轉譯與同步雲端時連刷送出。
- **`keyword_reply_builder.js`**: 
  - 新增 `isSavingKeyword` 與 `isDeletingKeyword`，就算是批次刪除勾選的大量資料，也確保前一個請求完成前，不會發送下一個。
  - 列表刷新新增 `isFetchingReplyList`，預防暴力洗重整鈕。

### 2. "Why" 導向的架構設計文件化
所有的 `function` 不只註解了它在做什麼，更明確寫出了「為什麼」需要這些防護機制：
- 例如針對 `handleKeywordSubmit` (儲存關鍵字)：
  - **Why**: 「防止因為網路延遲或滑鼠連點造成的重複新增。透過鎖住請求並搭配 UI Loading 狀態，避免建立出兩組相同的關鍵字觸發 LINE 機器人重複回覆。」
- 例如針對上傳 Imagemap：
  - **Why**: 「Imagemap 在發送時會同時夾帶高清晰度的本機圖檔，這是非常耗費網路頻寬的操作。必須預防雙擊塞爆 Worker 記憶體。」

---
**結論**: Phase 4 ( Builder 防護升級) 已順利通過審查。您的前端所有儲存與抓取邏輯現在都有了最堅固的防彈裝甲，不再害怕滑鼠連點或卡頓引發的崩潰狀態！
