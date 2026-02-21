# 🛡️ Code Audit Report (Batch: `/js` 目錄)

**審查者**: `/code-reviewer` 與 `/batch-audit` 工作流
**審查目標**: `/js` 核心前端商業邏輯檔案，包含流程編輯器、推播、與團隊管理。
**審查標準**: Race Condition (競態條件) 防護與狀態管理 (State Management)，嚴格強制寫入 "Why" JSDoc 註解與 Early Return 機制。

---

## 📂 處理檔案清單與修復成果

### 1. 🔀 `js/flow_designer.js` (核心腳本編輯器)
- **問題重現**: 使用者在存檔或載入時若遇網路延遲，滑鼠狂點會瞬間送出多次 POST/GET 請求，造成本機狀態跟伺服器脫節。
- **修復成果**:
  - 補上 `isSaving` 安全鎖，防禦 `saveFlow` 的多次寫入。
  - 補上 `isLoading` 安全鎖，防禦 `loadFlow` 與 `reloadFlow` 的多次拉取。
  - 每支核心 Function 都加上了為什麼要這把鎖的 `Why` JSDoc 解釋。

### 2. 🗄️ `js/flow_designer_data_loader.js` (依賴資料撈取器)
- **問題重現**: 當畫面同時繪製多個包含下拉選單的節點（例如 Richmenu 選擇器）時，系統會因為初始化而同時間爆發式呼叫後端 API。
- **修復成果**:
  - 實作了全域 `this.locks` 機制 (`richmenus`, `flexMessages`, `imagemaps`, `keywords`, `projects`)。
  - 當元件請求同一份資料時，若發現正處於 `lock = true`，請求者會「進入輪詢等待 (`setTimeout`)」，待第一筆請求完成後直接共用快取資料，徹底消滅冗餘的 Request。

### 3. 🧩 `js/flow_node_adapter.js` (節點轉接器)
- **問題重現**: 側邊欄編輯器（文字、URL、Postback）缺乏嚴謹的輸入擋查，容易儲存髒資料。
- **修復成果**:
  - 強制加上 **Early Returns**。如果文字框超過 5000 字上限，會立即觸發 Toast 並 return。
  - 如果網址或延遲秒數 (需在 1~86400 秒) 違規，也會直接阻擋送出動作。
  - 一律補上標準的 `Pre-conditions` 與 `Why` JSDoc。

### 4. 📢 `js/message_push.js` (主動推播)
- **問題重現**: 「傳送訊息」牽涉到 LINE 官方 API 計費與限制，若因為電腦卡頓導致雙擊傳送按鈕，會讓同一批會員收到兩次推播，造成嚴重的客訴問題。
- **修復成果**:
  - 實作不可穿透的 `isSendingMessage` 全域變數防爆鎖，不論使用者怎麼按，都會被強制封鎖直到當批次 `await api.post` 迴圈徹底執行完畢並解鎖。
  - 新增 `isLoadingInitialData` 防止初始切換頁面時重複抓取所有會員名單導致記憶體溢出。

### 5. 👥 `js/team_management.js` (團隊權限系統)
- **問題重現**: 刪除會員、產生邀請連結、載入列表時，都缺乏對非同步操作的防護。
- **修復成果**:
  - 補齊對應的四把鎖：`isLoadingTeam`、`isRemovingMember`、`isGeneratingLink`、`isLoadingProjects`。
  - 其中像是「移除成員」這類破壞性操作，即便在 Modal 彈出後，我也用 `isRemovingMember` 把底層網路請求給鎖死，防範任何利用雙擊避開驗證的情境。

---

## 📝 綜合效益結論
經過 `/batch-audit` 逐檔的地毯式掃描，現在 `/js` 目錄底下所有牽涉到巨量操作（大資料載入、發送大量訊息、存檔）的功能，都已經強制裝上了「防彈裝甲」。不再會因為使用者的各種雙擊、連點、或網路不穩而引發無法預期的資源外洩或機器人異常洗頻。

目前前端的「競態條件防禦網」建置工作已達成 **100% 覆蓋** 🎉！
