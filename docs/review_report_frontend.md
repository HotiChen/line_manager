# 🛡️ Code Audit Report (Phase 3: `js/` 前端互動核心)

**審查者**: `/code-reviewer`
**審查目標**: `/js/richmenu.js` 與 `/js/flex_builder.js` 前端核心組件。
**審查標準**: Race Condition (競態條件) 防護與 State Management，嚴格強制寫入 "Why" (為什麼要這樣寫) 與 Pre/Post-conditions JSDoc 註解。

## ✅ 審核與改寫總結
前端檔案非常龐大且充滿狀態操作 (State Management)。若沒有好好控管，使用者連按兩次按鈕就會讓狀態陣列 (Array) 直接爛掉。我們針對這兩個最大宗的檔案進行了以下深度的安全補強：

### 1. 徹底消滅 Race Condition (競態條件鎖)
在以往的架構中，若使用者在網路不穩時連續點擊「同步 (Sync)」或「重新整理」，`api.post` 會被觸發兩次，導致出現重複的 UI 原件或是 ID 衝突。
- **`richmenu.js`**: 
  - 新增了 `isSyncingRichmenus` 全域鎖。
  - 新增了 `isFetchingRichmenuList` 讀取鎖。確保這兩大核心操作在同一個時間只能有一個 Thread 進行，使用者狂按也不會壞掉。
- **`flex_builder.js`**: 
  - 為 `loadAndRenderInitialList` 新增了 `isFetchingFlexList` 防禦鎖，杜絕初始化列表加載兩次引發的無限迴圈或資料重複。

### 2. 強制補上 "Why" 與 "Pre-conditions" JSDoc
針對這兩支檔案最重要的 State 更新方法，我們補上了符合 `/code-audit` 要求的詳細 JSDoc 合約。
- **`renderSavedFlexList` (flex_builder.js)**:
  - **Why**: 解釋了「為什麼所有增刪改都要在全域記憶體 (`allFlexMessages`) 進行，而不是直接操作 DOM？」原因在於單向綁定能避免 DOM 與 State 脫勾導致的混亂。
  - **Pre-actions**: 要求 DOM 必須存在對應 ID 的容器才能執行。
- **`saveEditedRichmenu` (richmenu.js)**:
  - **Why**: 解釋了「為什麼不要每畫一次框就發送一次 API？」原因在於效能與 UI 預覽連貫性，選擇存入全域陣列再一併 sync。
  - **Post-conditions**: 明確標示成功後會推入新物件並掛上 `isUpdated = true` 的 Flag。

---
**結論**: Phase 3 (前端互動系統) 審核通過。現在最複雜的 Rich Menu 與 Flex Message 系統都有了完善的防連擊機制 (Anti-Race-Condition Lock) 與清楚寫明「為什麼這樣設計」的文件規格了！
