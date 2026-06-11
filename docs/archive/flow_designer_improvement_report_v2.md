# 視覺化流程設計器 — 第二輪改進報告

> 審查日期：2026-04-15  
> 基於第一輪報告修改後的程式碼再次審查

---

## 一、已修復確認 ✅

| # | 問題 | 狀態 |
|---|------|------|
| 1 | Z 鍵在輸入框中觸發 Focus 模式 | ✅ 已修復 (line 569 加入 tagName 判斷) |
| 2 | 循環檢測 (cycle detection) 未啟用 | ✅ 已修復 (`wouldCreateCycle()` BFS 實作完成，line 1808) |
| 3 | Dead CSS (`drawflow-*` 類名) | ✅ 完全重寫為實際 `.flow-node` 類名 |
| 4 | 缺少 Richmenu/Flex/Imagemap/Keyword 選擇器 | ✅ 已在 `flow_node_adapter.js` 中實作 |
| 5 | 缺少 Condition/API 編輯器 | ✅ 已實作 `createConditionEditor()` & `createAPIEditor()` |
| 6 | 後端無 payload 驗證 | ✅ 512KB + 200 節點限制 |
| 7 | 無版本歷史 | ✅ 30 天 TTL 版本快照 |
| 8 | `showFlowList()` 未實作 | ✅ 完整 Modal + 載入/刪除功能 (line 4550) |
| 9 | focusOnNode 直接修改 node.position (座標漂移) | ✅ 改為 scrollLeft/scrollTop 方式 |
| 10 | Imagemap 重複輸出點 | ✅ 已修復，只有一個輸出點 (line 1038) |
| 11 | `loadFlow` / `saveFlow` 缺少鎖定機制 | ✅ `isLoading` / `isSaving` 鎖定已加入 |

**改進幅度非常大，核心 Bug 全數修復。**

---

## 二、仍需修復的 Bug 🐛

### Bug 1: CSS `canvas.style.cssText` 模板字串有空格導致樣式失效
**嚴重度：高** | **檔案：`flow_designer.js` line 1901-1908**

```javascript
// ❌ 目前寫法（CSS 屬性名含空格，瀏覽器會忽略）
canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100 %;      // ← 錯誤！應為 100%
    height: 100 %;     // ← 錯誤！應為 100%
    pointer - events: none;  // ← 錯誤！應為 pointer-events
`;
```

**影響**：Richmenu 和 Imagemap 節點上的 Canvas 覆蓋層尺寸和事件穿透會失效，導致按鈕區域標示不會正確顯示。

**修正**：
```javascript
canvas.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
`;
```

---

### Bug 2: 雙重連線機制未統一
**嚴重度：中** | **檔案：`flow_designer.js`**

目前存在兩套完全獨立的連線系統：

1. **Click-based** (`startConnection` → `updateConnection` → `endConnection`, line 1317-1413)
   - 由 `node-output-point` 的 `onclick` 觸發
   - 使用 `this.connectionStart` / `this.isDraggingConnection` 狀態
   
2. **Drag-based** (`startConnectionDrag` → `updateConnectionDrag` → `endConnectionDrag`, line 1707-1803)
   - 由 `rightConnector` 的 `mousedown` 觸發
   - 使用 `this.connectionDragState` 狀態

**問題**：
- 每個節點同時掛載了兩套系統（`onclick` 在 innerHTML 輸出點 + `mousedown` 在 rightConnector）
- Richmenu/Flex/Imagemap 的特殊輸出點只有 `onclick` (click-based)，而通用 rightConnector 只用 drag-based
- 兩套系統行為不一致（click-based 用 `elementFromPoint` 找目標，drag-based 要求目標有 `node-connector` class + `data-type="input"`）

**建議**：統一為一套 drag-based 系統。保留 `startConnectionDrag` 作為唯一入口，移除 `startConnection`/`updateConnection`/`endConnection`。將所有 `onclick="flowDesigner.startConnection(...)"` 改為 `mousedown` handler 呼叫 `startConnectionDrag`。

---

### Bug 3: `endConnectionDrag` 目標判斷過於嚴格
**嚴重度：中** | **檔案：`flow_designer.js` line 1772-1787**

```javascript
endConnectionDrag(event) {
    // ...
    const target = event.target;
    if (target.classList.contains('node-connector') &&
        target.dataset.type === 'input') {
        // 只有精確點到 .node-connector[data-type=input] 才能連
    }
}
```

**問題**：使用者必須精確地將滑鼠放在 12px 的輸入圓點上才能完成連線。如果稍有偏差就會失敗且無任何反饋。

**修正**：改用 `document.elementFromPoint()` + 向上查找最近的 `.flow-node` 元素：
```javascript
endConnectionDrag(event) {
    if (!this.connectionDragState.isDragging) return;
    
    // 移除臨時線以免擋住 elementFromPoint
    if (this.connectionDragState.tempLine) {
        this.connectionDragState.tempLine.remove();
    }
    
    const el = document.elementFromPoint(event.clientX, event.clientY);
    const targetNode = el?.closest('.flow-node');
    
    if (targetNode && targetNode.id !== this.connectionDragState.sourceNodeId) {
        this.createEdge(
            this.connectionDragState.sourceNodeId,
            'default',
            targetNode.id,
            'input'
        );
    }
    
    // 重置狀態...
}
```

---

### Bug 4: End 節點不應有輸出點
**嚴重度：低** | **檔案：`flow_designer.js` line 1050-1071**

`renderNode()` 的 `else` 分支為「所有其他類型」統一加上輸出點，這包括了 End 節點。End 節點不應該有輸出連線。

**修正**：
```javascript
} else {
    innerHTML += `
        <div class="node-preview" style="font-size: 12px; color: #666;">
            ${this.getNodeDataPreview(node)}
        </div>
    `;
    
    // End 節點不加輸出點
    if (node.type !== NodeTypes.END) {
        innerHTML += `
            <div class="node-output-point" ...>
            </div>
        `;
    }
}
```

---

### Bug 5: `showFlowList` 的 XSS 風險
**嚴重度：中** | **檔案：`flow_designer.js` line 4581**

```javascript
<div class="fw-bold">${f.name}</div>
```

`f.name` 是使用者輸入，直接插入 HTML。惡意流程名稱如 `<img onerror=alert(1) src=x>` 可以執行任意 JavaScript。

**同樣問題存在於**：
- `flow_node_adapter.js` line 463: `${item[nameField] || '未命名'}`
- `flow_designer.js` line 1260: 錯誤訊息 `error.message` 直接插入
- `flow_designer.js` line 2351: 節點 config label/description

**修正**：加入 `escapeHtml()` 工具函數：
```javascript
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// 使用
`<div class="fw-bold">${escapeHtml(f.name)}</div>`
```

---

### Bug 6: `renderFlexPreview` 未轉義使用者文字
**嚴重度：中** | **檔案：`flow_designer.js` line 1850-1853**

```javascript
if (item.type === 'text') {
    const text = item.text || '';
    return text.length > 20 ? text.substring(0, 20) + '...' : text;
    // ← 直接回傳使用者文字，插入到 innerHTML 中
}
```

Flex Message 的 `text` 欄位可包含 HTML 標籤，會被瀏覽器解析。

**修正**：同上，使用 `escapeHtml()` 包裝。

---

## 三、架構改進建議 🏗️

### 改進 1: 加入自動儲存機制
**優先度：高**

目前只有 `Ctrl+S` 和手動點擊才會儲存到後端。使用者操作大量節點後若忘記儲存或瀏覽器崩潰，所有工作都會遺失（`saveToLocalStorage` 只保存到本地）。

**建議**：加入 debounced 自動儲存：
```javascript
constructor() {
    // ...
    this._autoSaveTimer = null;
}

scheduleAutoSave() {
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => {
        if (this.flowId) {
            this.saveFlow();
        }
    }, 30000); // 30 秒無操作後自動儲存
}

// 在所有 saveToLocalStorage() 呼叫後加上：
this.saveToLocalStorage();
this.scheduleAutoSave();
```

---

### 改進 2: 連線 `sourceHandle` 一致性
**優先度：中**

兩套連線系統傳入 `createEdge` 的參數不同：
- Click-based: `createEdge(nodeId, 'default', targetId, 'input')` — 有 handle
- Drag-based: `createEdge(sourceNodeId, null, targetNodeId, null)` — handle 為 null

這會導致 `edges` 陣列中 `sourceHandle` 有些是 `'default'`、有些是 `null`，在序列化儲存和後續判斷邏輯中造成不一致。

**修正**：統一為 `'default'`（或統一為 `null`），在 `createEdge` 中加入預設值：
```javascript
createEdge(sourceId, sourceHandle = 'default', targetId, targetHandle = 'input') {
    // ...
}
```

---

### 改進 3: Modal DOM 累積（記憶體洩漏）
**優先度：中**

`showFlowList()` 和 `showResourceModal()` 都使用 `insertAdjacentHTML` 注入 Modal HTML，並在 `hidden.bs.modal` 事件中 `remove()` DOM 元素。這個模式基本正確，但有邊界問題：

- 若使用者快速多次開啟 Modal（例如快速雙擊按鈕），可能在前一個 Modal hide 動畫完成前就注入了新的
- Bootstrap Modal 的 backdrop 可能殘留

**建議**：在注入新 Modal 前，清除同類型的舊 Modal：
```javascript
// showFlowList 開頭
document.querySelectorAll('[id^="flow-list-modal-"]').forEach(el => el.remove());
document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
```

---

### 改進 4: 新增「Export/Import JSON」功能
**優先度：低**

目前流程只能儲存到後端 KV。加入 JSON 匯出/匯入功能可以：
- 讓使用者備份流程到本地
- 在不同帳號間分享流程
- Debug 時快速複製流程狀態

```javascript
exportFlow() {
    const data = JSON.stringify({
        name: this.flowName,
        nodes: this.nodes,
        edges: this.edges,
        exportedAt: new Date().toISOString()
    }, null, 2);
    
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.flowName || 'flow'}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

importFlow() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const data = JSON.parse(text);
        this.flowName = data.name;
        this.nodes = data.nodes || [];
        this.edges = data.edges || [];
        this.flowId = null; // 匯入為新流程
        this.renderAll();
        toast.success('流程已匯入');
    };
    input.click();
}
```

---

### 改進 5: 節點位置碰撞檢測
**優先度：低**

新增節點時使用固定 offset 位置（或隨機位置），可能與現有節點重疊。建議在 `addNode` 中加入簡單的碰撞避免：

```javascript
findOpenPosition(baseX, baseY) {
    const SPACING = 40;
    let x = baseX, y = baseY;
    let attempts = 0;
    
    while (attempts < 50) {
        const overlap = this.nodes.some(n =>
            Math.abs(n.position.x - x) < 200 &&
            Math.abs(n.position.y - y) < 100
        );
        if (!overlap) break;
        x += SPACING;
        y += SPACING;
        attempts++;
    }
    return { x, y };
}
```

---

## 四、後端改進建議 (worker_src/handler/flow.js)

### 改進 1: 版本歷史查詢 API
**優先度：中**

已經在儲存時寫入 `flow_version_{...}_{timestamp}` 記錄，但缺少查詢 API 讓前端取得歷史列表。

```javascript
// GET /flow/versions/:flowId
export async function handleListVersions(request, env, userId, flowId) {
    const botId = await getActiveBotId(request, env, userId);
    const prefix = `flow_version_${userId}_${botId}_${flowId}_`;
    const list = await env.KV_LINE_STORAGE.list({ prefix });
    
    const versions = await Promise.all(
        list.keys.map(async (key) => {
            const raw = await env.KV_LINE_STORAGE.get(key.name);
            if (!raw) return null;
            const data = JSON.parse(raw);
            return {
                timestamp: key.name.replace(prefix, ''),
                name: data.name,
                nodeCount: (data.nodes || []).length,
                updatedAt: data.updatedAt
            };
        })
    );
    
    return jsonResponse({ success: true, versions: versions.filter(Boolean) });
}
```

在 `route()` 中加入：
```javascript
const versionsMatch = pathname.match(/^\/flow\/versions\/(.+)$/);
if (versionsMatch && request.method === 'GET') {
    return handleListVersions(request, env, userId, versionsMatch[1]);
}
```

### 改進 2: 流程名稱去除 HTML
**優先度：中**

```javascript
const name = (body.name || '未命名流程').replace(/<[^>]*>/g, '');
```

---

## 五、UX 改進建議 🎨

### UX 1: 未儲存變更提示
**優先度：高**

當使用者有未儲存的變更時，離開頁面應該跳出確認提示：

```javascript
// 在 constructor 或 init 中
this.isDirty = false;

// 在所有修改操作後
this.isDirty = true;

// 在 saveFlow 成功後
this.isDirty = false;

// 監聽頁面離開
window.addEventListener('beforeunload', (e) => {
    if (this.isDirty) {
        e.preventDefault();
        e.returnValue = '';
    }
});
```

### UX 2: 加入鍵盤快捷鍵提示
**優先度：低**

目前有 Z (Focus)、Ctrl+S (Save)、Delete、Ctrl+/-、Escape 等快捷鍵，但使用者無從得知。建議在工具列加一個「?」按鈕彈出快捷鍵列表。

### UX 3: 連線時的視覺反饋
**優先度：中**

拖拉連線接近目標節點時，目標節點應有視覺提示（如外框高亮），幫助使用者確認連線目標：

```javascript
// 在 updateConnectionDrag 中
const el = document.elementFromPoint(event.clientX, event.clientY);
const targetNode = el?.closest('.flow-node');

// 清除之前的高亮
document.querySelectorAll('.flow-node.connect-target').forEach(n => 
    n.classList.remove('connect-target'));

// 高亮目標
if (targetNode && targetNode.id !== this.connectionDragState.sourceNodeId) {
    targetNode.classList.add('connect-target');
}
```

CSS：
```css
.flow-node.connect-target {
    box-shadow: 0 0 0 3px rgba(46, 204, 113, 0.5) !important;
    border-color: #2ecc71 !important;
}
```

---

## 六、優先修復排序

| 順序 | 問題 | 影響 | 工作量 |
|------|------|------|--------|
| 1 | Bug 1: CSS 空格 (`100 %`, `pointer - events`) | Richmenu/Imagemap Canvas 完全失效 | 5 分鐘 |
| 2 | Bug 5+6: XSS 注入（加入 `escapeHtml`） | 安全性漏洞 | 20 分鐘 |
| 3 | 改進 1: 自動儲存 | 資料遺失風險 | 15 分鐘 |
| 4 | UX 1: 未儲存提示 | 使用者體驗 | 10 分鐘 |
| 5 | Bug 2+3: 統一連線機制 | 連線行為不一致 | 45 分鐘 |
| 6 | 改進 2: sourceHandle 一致性 | 資料一致性 | 10 分鐘 |
| 7 | Bug 4: End 節點輸出點 | 邏輯錯誤 | 5 分鐘 |
| 8 | 改進 3: Modal DOM 清理 | 記憶體洩漏 | 10 分鐘 |
| 9 | 後端改進 1: 版本歷史 API | 功能完整性 | 30 分鐘 |
| 10 | UX 3: 連線視覺反饋 | 使用者體驗 | 20 分鐘 |
| 11 | 改進 4: Export/Import | 功能增強 | 25 分鐘 |
| 12 | 改進 5: 碰撞檢測 | UX 增強 | 15 分鐘 |
| 13 | UX 2: 快捷鍵提示 | 可發現性 | 15 分鐘 |

---

## 總結

第一輪報告中的 **11 項主要問題已全數修復**，改進品質很高。  
第二輪發現 **6 個 Bug**（其中 1 個高嚴重度 CSS 錯誤）+ **5 項架構改進** + **3 項 UX 改進** + **2 項後端改進**。  
最優先處理的是 CSS 空格 Bug（5 分鐘修完）和 XSS 防護（20 分鐘）。
