---
name: dev-task-router
description: 智能開發任務路由器 - 自動判斷任務類型、複雜度並選擇最佳開發策略，減少 80% 手動確認
---

# Development Task Router (開發任務智能路由器)

## Purpose（目的）

為 LINE 管理後台項目提供自主決策能力，根據任務特性自動選擇最佳開發策略，包括：
- 前端 vs 後端任務判定
- 複雜度評估與開發方式選擇
- 測試策略自動決策
- 部署環境智能選擇

**核心價值**：讓 AI 助手從「問答機器」升級為「自主開發夥伴」，減少 50-80% 的人工確認。

## When to Use（觸發時機）

當用戶提出以下類型的請求時，**自動觸發**此 skill：

✅ 新增功能（如「新增一個會員篩選功能」）
✅ 修復 Bug（如「修復圖文選單無法顯示的問題」）
✅ UI/UX 改進（如「優化 Dashboard 卡片動畫」）
✅ 重構代碼（如「重構 API handler 結構」）
✅ 性能優化（如「加快會員列表載入速度」）

❌ **不觸發**的情況：
- 純粹的問答對話
- 查看檔案內容
- 簡單的配置修改

## Decision Tree Flow（決策樹流程）

### 🌳 完整決策流程圖

```
開始
  │
  ├─ 步驟 1: 任務分類
  │   ├─ 前端任務？ → [UI/組件/樣式/動畫]
  │   ├─ 後端任務？ → [API/數據庫/Worker]
  │   └─ 全棧任務？ → [前後端都涉及]
  │
  ├─ 步驟 2: 複雜度評分（0-10 分）
  │   ├─ 文件數量評分
  │   ├─ 影響範圍評分
  │   ├─ 技術難度評分
  │   └─ 風險等級評分
  │
  ├─ 步驟 3: 硬性規則匹配（優先級最高）
  │   ├─ 涉及數據庫 schema → 高複雜度處理
  │   ├─ 涉及 LINE API 修改 → 高複雜度處理
  │   ├─ 影響 > 5 個文件 → 高複雜度處理
  │   ├─ 純 CSS/樣式調整 → 快速處理
  │   └─ 純文檔更新 → 快速處理
  │
  ├─ 步驟 4: 基於評分的策略選擇
  │   ├─ 評分 >= 7 → 【深度開發模式】
  │   ├─ 評分 4-6 → 【標準開發模式】
  │   └─ 評分 < 4 → 【快速開發模式】
  │
  ├─ 步驟 5: 測試策略決策
  │   ├─ 涉及 API/數據 → 必須測試
  │   ├─ UI 組件 → 瀏覽器驗證
  │   └─ 樣式調整 → 視覺檢查
  │
  └─ 步驟 6: 部署環境選擇
      ├─ 高風險 → 建議 dev 環境
      ├─ 中風險 → 可直接本地測試
      └─ 低風險 → 快速驗證即可
```

---

## Detailed Decision Logic（詳細決策邏輯）

### 📊 Step 1: Task Classification（任務分類）

**自動判斷依據**：

```javascript
// 前端任務關鍵字
frontend_keywords = [
  "UI", "樣式", "CSS", "動畫", "頁面", "組件", 
  "按鈕", "卡片", "表單", "顯示", "視覺", "布局",
  "header", "sidebar", "dashboard", "flex", "richmenu"
]

// 後端任務關鍵字
backend_keywords = [
  "API", "數據庫", "handler", "worker", "route",
  "token", "member", "tag", "auth", "schema",
  "Cloudflare", "D1", "KV", "R2"
]

// 全棧任務關鍵字
fullstack_keywords = [
  "功能", "模組", "系統", "流程", "整合"
]
```

**分類規則**：
1. 如果只包含前端關鍵字 → `frontend_task`
2. 如果只包含後端關鍵字 → `backend_task`
3. 如果兩者都有 → `fullstack_task`
4. 如果不確定 → 分析涉及的文件路徑判斷

---

### 🎯 Step 2: Complexity Scoring（複雜度評分）

**評分標準（滿分 10 分）**：

#### 2.1 文件數量（0-2 分）
```
- 1 個文件：+0 分
- 2-3 個文件：+1 分
- 4-5 個文件：+1.5 分
- 6+ 個文件：+2 分
```

#### 2.2 影響範圍（0-3 分）
```
- 單一頁面/功能：+0.5 分
- 多個頁面：+1.5 分
- 核心系統（auth/member/token）：+2.5 分
- 全局影響（index.html/api.client.js）：+3 分
```

#### 2.3 技術難度（0-3 分）
```
- 簡單 CSS 調整：+0.5 分
- UI 組件開發：+1 分
- API 邏輯開發：+2 分
- 數據庫 schema 變更：+3 分
- 複雜算法/狀態管理：+3 分
```

#### 2.4 風險等級（0-2 分）
```
- 新增功能（不影響現有）：+0.5 分
- 修改現有功能：+1 分
- 重構核心邏輯：+1.5 分
- 涉及敏感數據/權限：+2 分
```

**計算範例**：
```
任務：新增會員批量標籤功能
- 文件數：3 個（member.js, tag_system.js, member.html）→ +1
- 影響範圍：核心系統 → +2.5
- 技術難度：API 邏輯 → +2
- 風險等級：修改現有功能 → +1
總分：6.5 分 → 標準開發模式
```

---

### ⚡ Step 3: Hard Rules Matching（硬性規則）

**優先級順序**：硬性規則 > 複雜度評分

#### 規則組 A：強制【深度開發模式】

```yaml
trigger_deep_mode_if:
  - 涉及數據庫 schema 變更（migration）
  - 修改 LINE Channel Access Token 處理邏輯
  - 涉及用戶認證/授權流程
  - 修改 Cloudflare Workers 路由結構
  - 影響 > 5 個文件
  - 引入新的第三方依賴
  - 涉及敏感數據處理
```

#### 規則組 B：允許【快速開發模式】

```yaml
trigger_fast_mode_if:
  - 純 CSS/樣式調整（不涉及 JS 邏輯）
  - 純文字/文檔更新
  - 修改靜態內容（如歡迎訊息文案）
  - 調整動畫參數
  - 修改顏色/間距等視覺變數
  - 單一 HTML 頁面小修改
```

#### 規則組 C：特殊情況處理

```yaml
# LINE API 相關
if task_involves_line_api:
  - 先檢查 LINE Developers 文檔
  - 使用 test 環境 token
  - 必須本地測試後再部署

# Cloudflare Workers 相關
if task_involves_workers:
  - 檢查 wrangler.jsonc 配置
  - 優先在 --local 環境測試
  - 涉及數據庫操作必須驗證 SQL

# 前端構建工具相關
if task_involves_flex_builder:
  - 檢查 flexcards.js 和 flex2html.js
  - 使用瀏覽器 subagent 視覺測試
  - 確保 LINE Flex 格式正確
```

---

### 🛠️ Step 4: Development Strategy Selection（開發策略）

根據複雜度評分和硬性規則，選擇三種模式之一：

#### 模式 A：【深度開發模式】（評分 >= 7 或觸發硬性規則）

**特徵**：謹慎、詳細、多重驗證

**執行流程**：
```
1. 📋 創建實作計劃（implementation_plan.md）
   - 詳細列出所有變更
   - 標註潛在風險點
   - 規劃測試策略

2. ⏸️ 請求用戶審查計劃
   - 使用 notify_user 工具
   - BlockedOnUser = true
   - 等待批准後繼續

3. 💻 分階段實作
   - 先實作核心邏輯
   - 再實作 UI 層
   - 最後整合測試

4. 🧪 完整測試
   - 後端：Wrangler dev 測試
   - 前端：Browser subagent 測試
   - 整合：端到端流程測試

5. 📄 創建 Walkthrough 文檔
   - 記錄所有變更
   - 附上測試截圖
   - 標註注意事項
```

#### 模式 B：【標準開發模式】（評分 4-6）

**特徵**：平衡效率與質量

**執行流程**：
```
1. 📝 快速計劃（task.md checklist）
   - 列出主要步驟
   - 標註關鍵檔案

2. 💻 直接實作
   - 不需要事前審查
   - 邊做邊更新 task.md

3. 🧪 基礎測試
   - 核心功能驗證
   - 使用 browser subagent 快速檢查

4. 📸 簡要記錄
   - 更新 walkthrough（如已存在）
   - 或者只在完成時總結
```

#### 模式 C：【快速開發模式】（評分 < 4）

**特徵**：快速、直接、最小化干預

**執行流程**：
```
1. ✏️ 直接修改
   - 不創建計劃文檔
   - 直接編輯目標文件

2. 👀 視覺驗證（如果是 UI 任務）
   - 使用 browser subagent 截圖
   - 確認效果符合預期

3. ✅ 完成確認
   - 簡短告知用戶已完成
   - 必要時提供截圖
```

---

### 🧪 Step 5: Testing Strategy（測試策略）

**自動決策邏輯**：

```yaml
# 後端 API 測試
if backend_task and involves_api:
  testing_method: "wrangler_dev_local"
  steps:
    - 啟動本地 dev server
    - 使用 curl 或瀏覽器測試 API endpoint
    - 檢查 console 輸出
    - 驗證返回數據格式

# 前端 UI 測試
if frontend_task and involves_ui:
  testing_method: "browser_subagent"
  steps:
    - 導航到相關頁面
    - 執行用戶交互動作
    - 截圖驗證視覺效果
    - 檢查 console 錯誤

# 全棧整合測試
if fullstack_task:
  testing_method: "end_to_end"
  steps:
    - 後端測試先行
    - 前端功能測試
    - 完整流程走一遍
    - 邊界條件測試

# 樣式調整（快速驗證）
if pure_styling:
  testing_method: "visual_check"
  steps:
    - 刷新頁面
    - 截圖對比
    - 確認無 CSS 錯誤
```

---

### 🚀 Step 6: Deployment Environment Selection（部署環境選擇）

**決策矩陣**：

| 任務風險 | 建議環境 | 理由 |
|---------|---------|------|
| **高風險** | `pinti-line-dev` | 涉及數據庫/API/核心邏輯，需要真實環境測試 |
| **中風險** | `localhost:8787` | 前後端整合，本地測試足夠 |
| **低風險** | `直接驗證` | 純 UI/樣式，瀏覽器刷新即可 |

**自動判斷代碼**：

```javascript
function selectDeploymentEnv(task) {
  // 高風險條件
  if (
    task.involves_database ||
    task.involves_line_api ||
    task.modifies_auth ||
    task.complexity_score >= 7
  ) {
    return {
      env: "pinti-line-dev",
      reason: "高風險變更，需要真實環境驗證",
      action: "建議用戶部署到 dev 環境測試"
    };
  }
  
  // 中風險條件
  if (
    task.involves_api ||
    task.complexity_score >= 4
  ) {
    return {
      env: "localhost:8787",
      reason: "標準開發任務，本地環境足夠",
      action: "使用 wrangler dev --local 測試"
    };
  }
  
  // 低風險條件
  return {
    env: "browser_refresh",
    reason: "低風險 UI 調整，直接驗證",
    action: "刷新瀏覽器確認效果"
  };
}
```

---

## Execution Workflow（執行工作流）

### 🎬 完整自動化流程

當用戶提交任務時，按以下順序自動執行：

```
┌─────────────────────────────────────────┐
│ 1. 接收用戶任務                          │
│    "請幫我優化會員列表的載入速度"         │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 2. 任務分類                              │
│    → 分析關鍵字：會員、列表、載入        │
│    → 判定：後端任務（涉及 API/數據）     │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 3. 複雜度評分                            │
│    文件數：2 個 → +1                     │
│    影響範圍：核心系統 → +2.5             │
│    技術難度：API 優化 → +2               │
│    風險等級：修改現有 → +1               │
│    總分：6.5 分                          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 4. 硬性規則檢查                          │
│    ✓ 涉及核心系統                        │
│    ✓ 影響用戶體驗                        │
│    → 建議：標準開發模式                  │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 5. 選擇開發策略                          │
│    → 【標準開發模式】                    │
│    → 創建 task.md checklist              │
│    → 直接開始實作                        │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 6. 測試策略                              │
│    → 後端測試（wrangler dev）            │
│    → 檢查 console 輸出                   │
│    → 測試 API 響應時間                   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 7. 部署建議                              │
│    → localhost:8787 足夠                 │
│    → 如需驗證真實數據，建議 dev 環境     │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 8. 自動執行（不詢問用戶）                │
│    ✓ 修改 member.js handler              │
│    ✓ 優化數據查詢邏輯                    │
│    ✓ 添加分頁或緩存機制                  │
│    ✓ 測試並驗證                          │
│    ✓ 報告完成                            │
└─────────────────────────────────────────┘
```

---

## Special Cases（特殊情況處理）

### 🔧 Case 1: 不確定任務類型時

```yaml
if ambiguous_task:
  action: "分析涉及的文件路徑"
  logic:
    - 檢查 user 提到的文件
    - 分析 git diff（如有）
    - 根據文件所在目錄判斷
    - 最後才詢問用戶（如真的無法判斷）
```

### 🔧 Case 2: 主要工具失敗時

```yaml
failover_strategy:
  primary: "直接實作並測試"
  
  if_primary_fails:
    - 檢查錯誤類型
    - 如果是環境問題 → 建議用戶檢查
    - 如果是邏輯問題 → 重新分析並調整方案
    - 如果仍失敗 → 降級到手動引導模式
```

### 🔧 Case 3: 涉及多個子任務時

```yaml
if task_has_subtasks:
  approach: "依序處理，自動劃分優先級"
  priority_order:
    1. 數據庫/API 變更（基礎設施）
    2. 後端邏輯實作
    3. 前端 API 調用
    4. UI 組件開發
    5. 樣式調整
    6. 測試與優化
```

---

## Configuration（配置參數）

可在此調整決策邏輯的閾值：

```yaml
# 複雜度閾值
complexity_thresholds:
  deep_mode: 7      # >= 7 分觸發深度模式
  standard_mode: 4  # 4-6 分使用標準模式
  fast_mode: 4      # < 4 分使用快速模式

# 文件數量閾值
file_count_thresholds:
  many_files: 6     # >= 6 視為影響廣泛
  few_files: 2      # <= 2 視為局部修改

# 自動執行開關
auto_execute:
  fast_mode: true       # 快速模式自動執行
  standard_mode: true   # 標準模式自動執行
  deep_mode: false      # 深度模式需審查

# 測試開關
always_test:
  backend_api: true     # 後端 API 必測
  frontend_ui: true     # 前端 UI 必測
  pure_styling: false   # 純樣式可跳過
```

---

## Benefits（核心優勢）

✅ **1. 真正的自主決策**
   - AI 不再頻繁詢問「接下來怎麼做？」
   - 根據預設邏輯自主判斷並執行
   - 減少 50-80% 的人工確認次數

✅ **2. 精準的任務分發**
   - 簡單任務快速處理
   - 複雜任務謹慎對待
   - 避免「殺雞用牛刀」或「輕視風險」

✅ **3. 一致的開發質量**
   - 統一的評分標準
   - 標準化的測試流程
   - 可追溯的決策邏輯

✅ **4. 完善的容錯機制**
   - 主方案失敗自動降級
   - 不確定情況有明確處理
   - 始終保證任務能完成

✅ **5. 項目專屬優化**
   - 針對 LINE 管理後台特性
   - 熟悉項目結構和技術棧
   - 智能處理 Cloudflare Workers 和 LINE API

---

## Examples（實際案例）

### 案例 1：新增會員批量導出功能

**用戶請求**：「幫我新增一個會員批量導出 CSV 的功能」

**自動決策流程**：
```
1. 任務分類：全棧任務（前端按鈕 + 後端 API）
2. 複雜度評分：
   - 文件數：3 個（member.html, member.js handler, 前端 JS）→ +1
   - 影響範圍：核心系統 → +2.5
   - 技術難度：API 開發 + CSV 生成 → +2
   - 風險等級：新增功能 → +0.5
   總分：6 分
3. 硬性規則：無觸發
4. 開發策略：【標準開發模式】
5. 測試策略：後端 API + 前端下載測試
6. 部署建議：localhost 測試，確認後可部署 dev

執行：
✓ 創建 task.md checklist
✓ 實作後端 CSV 生成邏輯
✓ 實作前端下載按鈕
✓ 測試下載功能
✓ 報告完成並提供截圖
```

### 案例 2：修改 Dashboard 卡片圓角

**用戶請求**：「把 Dashboard 的卡片圓角改成 12px」

**自動決策流程**：
```
1. 任務分類：前端任務（純 CSS）
2. 複雜度評分：
   - 文件數：1 個（CSS 文件）→ +0
   - 影響範圍：單一頁面 → +0.5
   - 技術難度：CSS 調整 → +0.5
   - 風險等級：樣式調整 → +0.5
   總分：1.5 分
3. 硬性規則：觸發「純 CSS 調整」→ 快速模式
4. 開發策略：【快速開發模式】
5. 測試策略：視覺檢查
6. 部署建議：刷新瀏覽器即可

執行：
✓ 直接修改 CSS
✓ 瀏覽器 subagent 截圖
✓ 確認完成
```

### 案例 3：修改 Channel Access Token 更新邏輯

**用戶請求**：「修復 Channel Token 無法更新的問題」

**自動決策流程**：
```
1. 任務分類：後端任務（API handler）
2. 複雜度評分：
   - 文件數：2 個（token.js handler, 可能涉及 DB）→ +1
   - 影響範圍：核心系統（認證）→ +2.5
   - 技術難度：API 邏輯 → +2
   - 風險等級：涉及敏感數據 → +2
   總分：7.5 分
3. 硬性規則：觸發「涉及 LINE Token」→ 深度模式
4. 開發策略：【深度開發模式】
5. 測試策略：必須完整測試 token 流程
6. 部署建議：強烈建議 dev 環境驗證

執行：
✓ 創建 implementation_plan.md
✓ 請求用戶審查計劃（notify_user）
✓ 等待批准
✓ 謹慎實作並添加錯誤處理
✓ 完整測試 token 更新流程
✓ 創建詳細 walkthrough 文檔
```

---

## Integration with Workflows（與工作流整合）

### 創建斜杠命令快速調用

1. 在 `.agent/workflows/` 創建 `auto-dev.md`：

```markdown
---
description: 智能開發 - 自動判斷並執行開發任務
---

Use the @dev-task-router skill to automatically analyze the task,
determine complexity, select the best development strategy,
and execute with minimal user intervention.
```

2. 使用方式：
```
用戶：/auto-dev 新增會員標籤批量功能
      ↓
AI 自動：分析 → 評分 → 選策略 → 執行 → 測試 → 完成
```

---

## Maintenance Notes（維護說明）

### 調整決策邏輯

如果發現決策不夠準確，可以調整：

1. **修改複雜度權重**：編輯 Step 2 的評分標準
2. **新增硬性規則**：在 Step 3 添加特定情況處理
3. **調整閾值**：修改 Configuration 區塊的數值

### 監控效能

定期檢查：
- 自動決策的準確率
- 用戶手動干預的頻率
- 測試通過率

### 持續優化

根據實際使用情況：
- 補充新的案例模式
- 完善特殊情況處理
- 優化評分算法

---

## Conclusion（總結）

這個決策樹 skill 讓 AI 助手從「被動執行者」升級為「主動決策者」，特別針對 LINE 管理後台項目的特性進行了優化。

**核心理念**：
- 📊 數據驅動決策（評分系統）
- 🎯 明確的優先級（硬性規則）
- 🔄 完善的容錯機制
- 🚀 最大化自主性（減少詢問）

**預期效果**：
- ⏱️ 節省 50-80% 確認時間
- ✅ 提高開發一致性
- 🛡️ 降低風險（該謹慎時謹慎）
- 🎨 保持質量（該快速時快速）

現在開始享受真正的 AI 自主開發體驗吧！🎉
