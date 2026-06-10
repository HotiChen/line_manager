# LINE Bot 視覺化流程設計器 - 實作計劃

**專案代號**: Flow Designer  
**版本**: v1.0.0  
**創建日期**: 2025-12-14

---

## 📋 專案概述

打造一個類似 n8n 的視覺化流程編輯器，專門用於設計 LINE Bot 的對話流程。

### 核心功能
- ✅ 拖拉式節點編輯器
- ✅ 右鍵選單新增節點
- ✅ 節點連線功能
- ✅ Richmenu 多輸出支援
- ✅ 流程儲存/載入
- ✅ 即時預覽
- ✅ 流程測試

---

## 🎯 使用情境範例

### 情境 1: 客服流程
```
[Richmenu: 主選單]
├─ 按鈕1: 常見問題 
│  └─> [Flex: FAQ 列表]
│      ├─ 按鈕: 營業時間 → [文字: 營業時間資訊]
│      ├─ 按鈕: 聯絡方式 → [文字: 聯絡資訊]
│      └─ 按鈕: 返回主選單 → [Richmenu: 主選單]
│
├─ 按鈕2: 聯絡客服
│  └─> [文字: 請稍候，為您轉接...]
│      └─> [API: 通知客服]
│         └─> [結束]
│
└─ 按鈕3: 關於我們
   └─> [Imagemap: 公司簡介]
       └─> [結束]
```

### 情境 2: 會員註冊流程
```
[關鍵字觸發: "註冊"]
└─> [文字: 請問您的姓名？]
    └─> [等待回覆]
        └─> [標籤: 新增 "待註冊"]
            └─> [文字: 請問您的電話？]
                └─> [等待回覆]
                    └─> [條件: 電話格式檢查]
                        ├─ 正確 → [API: 註冊會員] → [Flex: 註冊成功]
                        └─ 錯誤 → [文字: 格式錯誤] → [返回輸入電話]
```

---

## 🏗️ 技術架構

### 前端技術棧
```
技術選型（三選一）：

選項 A: React Flow ⭐ 推薦
├─ React 18
├─ React Flow 11
├─ Zustand (狀態管理)
└─ TailwindCSS (樣式)

選項 B: Rete.js
├─ Vanilla JS
├─ Rete.js 2.0
└─ Bootstrap 5

選項 C: 純手工
├─ Canvas API
├─ SVG
└─ Vanilla JS
```

### 後端 API

需要新增的端點：

```javascript
// 流程管理
POST   /flow/save          // 儲存流程
GET    /flow/list          // 列出所有流程
GET    /flow/get/:id       // 取得單一流程
DELETE /flow/delete/:id    // 刪除流程
POST   /flow/test          // 測試流程

// 流程執行
POST   /flow/execute/:id   // 執行特定流程
GET    /flow/logs/:id      // 取得執行日誌
```

---

## 📦 節點類型詳細設計

### 1. Richmenu 節點

```javascript
{
  type: 'richmenu',
  data: {
    richmenuId: 'richmenu_abc',
    name: '主選單',
    buttons: [
      {
        id: 'btn_1',
        label: '常見問題',
        bounds: { x: 0, y: 0, width: 833, height: 843 },
        action: { type: 'message', text: 'FAQ' }
      },
      {
        id: 'btn_2',
        label: '聯絡客服',
        bounds: { x: 833, y: 0, width: 833, height: 843 },
        action: { type: 'message', text: '客服' }
      }
    ]
  },
  // 輸出點：每個按鈕一個
  outputs: {
    btn_1: { label: '常見問題', handle: 'btn_1' },
    btn_2: { label: '聯絡客服', handle: 'btn_2' }
  }
}
```

### 2. Flex Message 節點

```javascript
{
  type: 'message_flex',
  data: {
    flexId: 'flex_123',
    title: 'FAQ 列表',
    buttons: [
      { id: 'action_1', label: '營業時間' },
      { id: 'action_2', label: '聯絡方式' },
      { id: 'action_3', label: '返回' }
    ]
  },
  // 如果 Flex 有互動按鈕，也可以有多個輸出
  outputs: {
    action_1: { label: '營業時間', handle: 'action_1' },
    action_2: { label: '聯絡方式', handle: 'action_2' },
    action_3: { label: '返回', handle: 'action_3' }
  }
}
```

### 3. 條件判斷節點

```javascript
{
  type: 'action_condition',
  data: {
    conditions: [
      {
        field: 'user.message',  // 檢查的欄位
        operator: 'matches',     // 比較運算子
        value: '^09[0-9]{8}$',  // 比較值（正則）
        label: '電話格式正確'
      }
    ]
  },
  outputs: {
    true: { label: '條件成立', handle: 'true' },
    false: { label: '條件失敗', handle: 'false' }
  }
}
```

---

## 🎨 UI 設計規格

### 畫布 (Canvas)
- **背景**: 淺灰色網格 (20px x 20px)
- **縮放範圍**: 25% - 200%
- **平移**: 滑鼠中鍵拖曳或空白處拖曳
- **小地圖**: 右下角顯示整體流程縮略圖

### 節點設計
```
┌─────────────────────────┐
│ 🎯 Richmenu: 主選單      │  ← 節點標題（圖示 + 名稱）
├─────────────────────────┤
│ • 選單名稱               │  ← 節點內容預覽
│ • 3 個按鈕               │
├─────────────────────────┤
│ ○ 常見問題 ────────→    │  ← 輸出點（每個按鈕一個）
│ ○ 聯絡客服 ────────→    │
│ ○ 關於我們 ────────→    │
└─────────────────────────┘
```

### 節點顏色系統
```css
/* 觸發器 */
.node-trigger {
  border-color: #9b59b6;  /* 紫色 */
}

/* 訊息 */
.node-message {
  border-color: #3498db;  /* 藍色 */
}

/* 動作 */
.node-action {
  border-color: #f39c12;  /* 橘色 */
}

/* UI/UX */
.node-ui {
  border-color: #1abc9c;  /* 綠色 */
}

/* 結束 */
.node-end {
  border-color: #e74c3c;  /* 紅色 */
}
```

### 連線樣式
- **預設**: 實線，2px，#95a5a6
- **選中**: 3px，#3498db
- **錯誤**: 虛線，2px，#e74c3c
- **動畫**: 流程執行時顯示動畫路徑

---

## 🔧 開發階段

### Phase 1: 基礎架構 (1-2 天)
- [x] 創建基礎 HTML 頁面
- [x] 創建 FlowDesigner 類別
- [ ] 整合 React Flow / Rete.js
- [ ] 實作基本拖拉功能
- [ ] 實作右鍵選單

### Phase 2: 節點系統 (2-3 天)
- [ ] 實作所有節點類型
- [ ] 節點屬性編輯器
- [ ] 節點資料驗證
- [ ] 多輸出節點支援

### Phase 3: 連線系統 (1-2 天)
- [ ] 節點連線功能
- [ ] 連線驗證（防止循環）
- [ ] 連線樣式自定義
- [ ] 連線刪除

### Phase 4: 資料整合 (2-3 天)
- [ ] 與現有 Richmenu 資料整合
- [ ] 與 Flex/Imagemap Builder 整合
- [ ] 與關鍵字系統整合
- [ ] 與標籤系統整合

### Phase 5: 儲存/載入 (1-2 天)
- [ ] 實作後端 API
- [ ] 流程儲存功能
- [ ] 流程載入功能
- [ ] 自動儲存草稿

### Phase 6: 測試與執行 (2-3 天)
- [ ] 流程驗證器
- [ ] 流程模擬執行
- [ ] 執行日誌
- [ ] 錯誤提示

### Phase 7: 優化 (1-2 天)
- [ ] 效能優化
- [ ] UI/UX 改善
- [ ] 快捷鍵
- [ ] 使用教學

**總預估時間**: 10-17 天

---

## 📝 資料結構範例

### 完整流程 JSON
```json
{
  "id": "flow_customer_service",
  "name": "客服流程 v1.0",
  "description": "處理客戶常見問題",
  "version": "1.0.0",
  "createdAt": "2025-12-14T02:00:00Z",
  "updatedAt": "2025-12-14T03:00:00Z",
  "nodes": [
    {
      "id": "node_1",
      "type": "richmenu",
      "position": { "x": 100, "y": 100 },
      "data": {
        "richmenuId": "richmenu_main",
        "name": "主選單",
        "buttons": [
          {
            "id": "btn_faq",
            "label": "常見問題",
            "bounds": { "x": 0, "y": 0, "width": 833, "height": 843 }
          }
        ]
      }
    },
    {
      "id": "node_2",
      "type": "message_flex",
      "position": { "x": 400, "y": 100 },
      "data": {
        "flexId": "flex_faq_list",
        "title": "FAQ 列表"
      }
    }
  ],
  "edges": [
    {
      "id": "edge_1",
      "source": "node_1",
      "sourceHandle": "btn_faq",
      "target": "node_2",
      "targetHandle": "input",
      "style": { "stroke": "#3498db" }
    }
  ],
  "settings": {
    "viewport": { "x": 0, "y": 0, "zoom": 1 },
    "enableAutoSave": true,
    "autoSaveInterval": 30000
  }
}
```

---

## 🎯 進階功能規劃

### 1. 流程版本控制
- Git-like 版本管理
- 版本比較
- 回滾功能

### 2. 協作功能
- 多人即時編輯
- 評論系統
- 變更追蹤

### 3. 模板系統
- 官方模板庫
- 自定義模板
- 模板市場

### 4. A/B 測試
- 流程變體測試
- 數據分析
- 自動優化建議

### 5. AI 助手
- 自動生成流程
- 流程優化建議
- 智能錯誤檢測

---

## 🚀 快速開始

### 開發環境設置

```bash
# 1. 安裝依賴
npm install react react-dom reactflow

# 2. 啟動開發服務器
npx wrangler dev --env dev --port 8787

# 3. 訪問頁面
open http://localhost:8787/pages/flow_designer.html
```

### 創建第一個流程

1. 右鍵點擊畫布
2. 選擇「新增 Richmenu」
3. 選擇已存在的 Richmenu
4. 右鍵再次點擊，選擇「新增 Flex Message」
5. 從 Richmenu 的按鈕拖曳連線到 Flex
6. Ctrl+S 儲存

---

## 📚 參考資源

### 相似專案
- [n8n](https://n8n.io/) - Workflow Automation
- [Node-RED](https://nodered.org/) - Flow-based Programming
- [Flowise](https://flowiseai.com/) - LLM Apps Builder
- [Botpress](https://botpress.com/) - Chatbot Builder

### 技術文檔
- [React Flow Docs](https://reactflow.dev/)
- [Rete.js Docs](https://rete.js.org/)
- [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/)

---

## 🐛 已知限制與解決方案

### 限制 1: 循環檢測
**問題**: 流程可能形成無限循環  
**解決**: 實作圖論演算法檢測環

### 限制 2: 複雜度控制
**問題**: 過於複雜的流程難以維護  
**解決**: 
- 限制節點數量（建議 < 50）
- 提供流程複雜度評分
- 建議拆分成子流程

### 限制 3: 效能
**問題**: 大型流程可能卡頓  
**解決**:
- 虛擬化渲染
- 懶加載節點
- Web Worker 處理計算

---

## 📄 授權

本專案為內部使用，未經授權不得分發。

---

**最後更新**: 2025-12-14  
**維護者**: Tim Chen
