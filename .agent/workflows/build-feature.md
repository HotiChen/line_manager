---
description: 功能開發實作 - 根據工單 (Task Tracker) 依序接力開發資料庫、前後端邏輯與 UI 設計的標準流程
---

# ⚙️ 功能開發與 UI 實作流水線 (Feature Build Flow)

此工作流 (Workflow) 負責處理從「接收 Ticket」到「產生功能可運作、畫面美觀的 MVP」的實作階段。這是一條嚴密的裝配線，確保依據依賴關係 (Dependencies) 正確指派工程師，避免前端找不到 API，或後端沒有 Data Schema 的窘境。

## 🎯 前置條件 (Prerequisites)

*   必須存在由 `/start-epic` 產出的 `docs/task_tracker.md` 與架構文件。如果您還沒有這些文件，請先運行 `/start-epic` 指令。

## 🎯 運作流程與接力順序

當您指定要開發某個功能或 Ticket 時，系統將依序喚醒以下專家：

1. **🗄️ `/dba-expert` (資料庫管理專家) 建立根基**
   - **輸入**: 讀取 `task_tracker.md` 的 Task 與 `ARCHITECTURE.md` 的 ERD。
   - **職責**: 實作 Schema Migration (例如建立 Table、加上關聯與 Index 索引)。
   - **檢查**: 若涉及搶購或高併發的扣款邏輯，確保提示後端要加 Row-level Lock 或 Transaction。

2. **⚙️ `/backend-dev` (後端工程師) 引擎點火**
   - **輸入**: 承接 DBA 建立好的 Database Schema。
   - **職責**: 開發 RESTful 或 GraphQL API 端點。
   - **強制規範**: 實作 Clean Architecture，做好 Input Validation，且若是金流相關，強制加入 **Webhook 驗證與冪等性 (Idempotency)**。產出帶有 JSDoc 的程式碼。

3. **💻 `/frontend-dev` (前端邏輯工程師) 接通迴路**
   - **輸入**: 呼叫後端工程師開發好的 API。
   - **職責**: 實作資料綁定 (State Management) 與畫面互動邏輯 (Event Listeners)。
   - **強制規範**: 執行「極致防呆機制」，所有 Submit 按鈕必須有 `disabled` Loading 狀態與 Try-Catch Toast 錯誤提示。此階段不修飾華麗的 CSS。

4. **🎨 `/frontend-designer` (前端 UI/UX 設計師) 極致美學**
   - **輸入**: 接收前端寫好但長得很醜的 Component 或 HTML。
   - **職責**: 注入色彩心理學、留白排版與滑順的微動畫 (Micro-interactions)。
   - **強制規範**: 確保在各尺寸裝置上皆為響應式 (RWD)，並且為沒有資料的頁面實作精美的「Empty State (防呆引導空狀態)」。

## 🚀 使用方式

當手邊有明確的任務時使用：

```
/build-feature 請參考 docs/task_tracker.md，幫我開始進行 [Phase 1: 建立會員登入核心系統] 的實作。
/build-feature 我要開發一個「上傳圖片至雲端」的功能，請依據流水線串接 S3 到前端。
```

> **⚡ AI 行為準則**: 
> - **嚴格依序執行 (Sequential Execution)**：絕不允許在 `/backend-dev` 產生 API 規格前，就讓前端開始實作互動邏輯。
> - 在每個專家完成自己的模組後，必須向 USER 簡報「實作了什麼」，並詢問是否同意接力給下一位專家。
> - 在這個工作階段中，**不要使用 `/code-reviewer` 或 `/security-auditor`**，實作階段重點在功能可動與流暢，驗收應交由下一個 `/qa-deploy` 工作流處理。
