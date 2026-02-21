# 更新日誌 (Changelog)

## 2026-02-21 - Agent Workflows & JS Batch Audit

### 🆕 新增功能 / 系統增強 (Features & Enhancements)

#### 1. 🤖 自動化工作流 (Agent Workflows)
建立並啟用了多個標準化開發流程腳本，提升開發紀律與自動化程度：
- `/auto-dev`: 快速/深度開發智能路由
- `/batch-audit`: 逐檔批次稽核程式碼 (防呆機制覆蓋)
- `/build-feature`: 完整的前後端功能開發藍圖
- `/qa-deploy`: 測試與上線部署流程
- `/sos-emergency`: 緊急 Root Cause 分析與救火流程
- `/start-epic`: 產品 PRD 與規格發想工作流
- `/auto-commit`: 自動化盤點變更與 Git 提交

#### 2. 🛡️ 前端核心邏輯加固 (Batch Audit JS)
對所有大型互動元件進行全面的競態條件 (Race Condition) 掃描，新增多把防連點、防重複載入的安全鎖，並補齊 `Why` 之 JSDoc 註解：
- `flow_designer.js` & `flow_designer_data_loader.js`: 鎖定存檔 (`isSaving`) 與拉取 API (`isLoading`)。
- `flow_node_adapter.js`: 側邊欄表單之 Early Returns 字數限制與防呆。
- `message_push.js`: 推播發送前之雙重鎖定防護 (`isSending`)。
- `team_management.js`: 踢除成員及載入名單之不可穿透保護。
- `message.helper.js`: 實作 `inflightRequests` Map 防範同秒發送重複 API 網路風暴。

#### 3. 🎨 UI/UX 視覺與架構升級
抽離並模組化多個前端 CSS，落實防呆視覺引導與進階美學：
- `empty-state.css`: 優化無資料時的空狀態體驗。
- `z-index-system.css`: 建立全域層級管理，避免 Modal 疊加衝突。
- `theme-system.css` & `dark-mode-fixes.css`: 導入色彩變數與修復深色介面。
- `typography-enhanced.css` & `animations-enhanced.css`: 導入流暢微動畫與排版。

---

## 2024-12-28 - Quick Reply & 變數替換功能

### 🆕 新增功能

#### 1. 訊息變數替換
在文字訊息中可以使用以下變數，會在發送時自動替換：
- `(@name)` - 使用者 LINE 顯示名稱
- `(@date)` - 今天日期 (例：2024/12/28)
- `(@time)` - 現在時間 (例：14:30)
- `(@day)` - 星期幾 (例：星期六)
- `(@year)` - 年份
- `(@month)` - 月份

#### 2. Quick Reply Keyword 層級支援
- QR 現在附加在**整個關鍵字回覆**，而不是個別回覆
- QR 會自動附加到最後一則訊息
- 向下相容舊的 reply-level QR 資料

#### 3. 前端 UI 改進
- 文字輸入框下方新增**變數快速插入按鈕**
- Keyword Modal 重新排版：回覆內容 → 加入按鈕 → 已加入回覆 → QR 選項
- 關鍵字列表顯示 QR badge 標記
- QR 下拉選單去除重複項目

---

### 📁 修改檔案

#### Frontend
- `pages/keyword_reply_builder.html` - Modal 排版調整
- `js/keyword_reply_builder.js` - QR 改為 keyword-level、QR 去重
- `helper/message.helper.js` - 新增變數插入按鈕

#### Webhook
- `worker_src/lib/event_handler.js` - 新增/更新
  - `getLineUserProfile()` - 取得使用者 Profile
  - `replaceMessageVariables()` - 變數替換
  - `getQuickReplyTemplate()` - 多 KV key 相容
  - `handleMessageEvent()` - keyword-level QR
  - `handleFollowEvent()` - keyword-level QR

---

### ⚠️ 注意事項

1. **舊資料相容**：系統會自動檢查 reply-level 和 keyword-level 的 QR
2. **Webhook 部署**：記得將 `event_handler.js` 部署到 Cloudflare Worker
