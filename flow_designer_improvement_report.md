# 視覺化流程設計器 — 改進報告

**分析範圍**：`flow_designer.js`（4,751行）、`flow_designer_data_loader.js`（464行）、`flow_node_adapter.js`（371行）、`flow_designer_full.html`（579行）、`worker_src/handler/flow.js`（178行）

---

## 一、嚴重 Bug（必須修復）

### Bug 1：Imagemap 節點重複渲染輸出點

**檔案**：`js/flow_designer.js` 第 1004-1063 行

Imagemap 節點的 `renderNode()` 中，輸出點（output point）被渲染了**兩次**，導致畫面上出現兩個重疊的連接圓點。

```javascript
// 第一個輸出點（約 1031 行）
innerHTML += `<div class="node-output-point" ...>`;

// 不小心又加了 node-preview + 第二個輸出點（約 1046-1063 行）
innerHTML += `<div class="node-preview"...>`;
innerHTML += `<div class="node-output-point" ...>`;  // ← 重複！
```

**修復方式**：刪除第二組 `node-preview` + `node-output-point`（第 1044-1063 行的 else 分支裡那段），只保留第一個。

---

### Bug 2：循環檢測被註解掉

**檔案**：`js/flow_designer.js` 第 1427-1432 行

```javascript
// 檢查是否會形成循環（暫時禁用，稍後改進）
// if (this.wouldCreateCycle(sourceId, targetId)) { ... }
```

循環檢測邏輯 `wouldCreateCycle()` 已經實作完成（第 1793 行），但在 `createEdge()` 中被註解掉了。這會導致使用者可以建立無限迴圈的流程，造成後端執行時無限遞迴。

**修復方式**：取消註解即可，函數已經可以正常工作。

---

### Bug 3：`focusOnNode()` 移動所有節點的座標

**檔案**：`js/flow_designer.js` 第 3896-3899 行

```javascript
// 平移所有節點
this.nodes.forEach(n => {
    n.position.x += deltaX;
    n.position.y += deltaY;
});
```

聚焦到某節點時，竟然修改了**所有節點的 position**。這意味著每次按 Z 聚焦，整個流程圖的座標都會永久偏移，多次操作後座標會飄到極端位置。

**修復方式**：改為只滾動畫布容器的 scrollLeft/scrollTop，不要修改節點座標：

```javascript
focusOnNode(nodeId) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return;

    this.canvasZoom = 1.5;
    this.applyCanvasZoom();

    const containerW = this.container.clientWidth;
    const containerH = this.container.clientHeight;

    this.container.scrollLeft = node.position.x * this.canvasZoom - containerW / 2;
    this.container.scrollTop = node.position.y * this.canvasZoom - containerH / 2;

    this.selectNode(nodeId);
    this.showNodeProperties(nodeId);
}
```

---

### Bug 4：Z 鍵在輸入框也觸發 Focus Mode

**檔案**：`js/flow_designer.js` 第 567 行

```javascript
if (e.key === 'z' || e.key === 'Z') {
    if (!this.focusMode) { ... }
}
```

當使用者在側邊欄文字編輯器中打 "z" 時，會意外觸發 Focus Mode，游標變成十字。

**修復方式**：

```javascript
if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey) {
    // 忽略在輸入框中的按鍵
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (!this.focusMode) { ... }
}
```

同理，Delete 鍵（第 591 行）也需要加相同的 guard。

---

### Bug 5：新分頁無法取得身份驗證

**檔案**：`helper/state.js`

流程設計器在新分頁中開啟時，`getUserId()` 回傳 null（記憶體中的 state 不會跨分頁共享），導致所有 API 呼叫都缺少 `X-User-Id` header。

**狀態**：已在先前的對話中修復（加入 sessionStorage 持久化）。

---

## 二、功能缺失（未完成的編輯器）

### 缺失 1：四個節點選擇器只有佔位符

**檔案**：`js/flow_node_adapter.js` 第 344-367 行

```javascript
static async openRichmenuSelector(node, onSave) {
    toast.info('请从主选单的 "Richmenu 管理" 编辑 Richmenu');  // ← 只有 toast
}
static async openFlexSelector(node, onSave) {
    toast.info('Flex 選擇器開發中...');
}
static async openImagemapSelector(node, onSave) {
    toast.info('Imagemap 選擇器開發中...');
}
static async openKeywordEditor(node, onSave) {
    toast.info('Keyword 編輯器開發中...');
}
```

這四個關鍵編輯器完全沒有實作。使用者雙擊 Richmenu / Flex / Imagemap / Keyword 節點時，只會看到一個 Toast 訊息。

**改進方式**：為每個選擇器建立 Modal 對話框，利用已存在的 `dataLoader` 載入資源列表。以 Flex Message 選擇器為例：

```javascript
static async openFlexSelector(node, onSave) {
    // 載入可用的 Flex Message 列表
    const flexList = await dataLoader.loadFlexMessages();

    if (flexList.length === 0) {
        toast.warning('尚未建立任何 Flex Message，請先前往 Flex Message 管理新增');
        return;
    }

    // 建立選擇用的 Modal
    const modal = document.createElement('div');
    modal.className = 'modal fade';
    modal.innerHTML = `
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">選擇 Flex Message</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body">
                    <div class="list-group">
                        ${flexList.map(f => `
                            <button class="list-group-item list-group-item-action"
                                    data-flex-id="${f.id}">
                                <strong>${f.title || f.altText || '未命名'}</strong>
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const bsModal = new bootstrap.Modal(modal);

    modal.querySelectorAll('[data-flex-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const flexId = btn.dataset.flexId;
            const details = await dataLoader.loadFlexMessageDetails(flexId);
            if (details) {
                node.data.flexId = details.flexId;
                node.data.title = details.title;
                node.data.contents = details.contents;
                onSave(node);
                toast.success('Flex Message 已選取');
            }
            bsModal.hide();
        });
    });

    modal.addEventListener('hidden.bs.modal', () => modal.remove());
    bsModal.show();
}
```

同樣的模式可以套用在 Richmenu、Imagemap、Keyword 上。`dataLoader` 已經有對應的載入函數。

---

### 缺失 2：ACTION_CONDITION 和 ACTION_API 節點無法編輯

雖然定義了 `ACTION_CONDITION` 和 `ACTION_API` 節點類型，但：
- 沒有在 `FlowNodeAdapter.editNode()` 的 switch 中處理
- 沒有對應的編輯器 UI
- 預設資料結構（conditions/branches）也沒有 UI 來操作

**改進方式**：
- 條件節點：建立條件編輯器，讓使用者設定 field/operator/value，並在節點右側顯示多個輸出端點（true/false）
- API 節點：建立 URL + method + headers + body 的表單

---

### 缺失 3：沒有流程列表管理

後端已有完整的 CRUD API（`/flow/list`、`/flow/save`、`/flow/get/:id`、`/flow/delete/:id`），但前端沒有任何 UI 讓使用者：
- 查看已儲存的流程列表
- 從列表中選擇載入
- 刪除舊流程
- 重新命名流程

**改進方式**：在工具列新增「我的流程」按鈕，開啟一個 Modal 列表：

```javascript
async showFlowList() {
    const data = await api.get('/flow/list');
    const flows = data.flows || [];

    // 建立 Modal 顯示流程列表
    // 每個流程項目包含：名稱、節點/邊數量、最後更新時間
    // 操作按鈕：載入、刪除、重新命名
}
```

---

## 三、架構與效能問題

### 問題 1：單檔案 4,751 行（God Object）

`flow_designer.js` 包含了畫布管理、節點渲染、連線管理、縮放控制、拖曳邏輯、序列化/反序列化、除錯工具等所有功能。

**建議拆分**：

| 新檔案 | 負責內容 | 約行數 |
|--------|---------|--------|
| `flow_canvas.js` | 畫布平移、縮放、框選、觸控手勢 | ~300 |
| `flow_connection.js` | 連線建立、刪除、拖曳、Bezier 計算 | ~400 |
| `flow_node_renderer.js` | 節點渲染（含 Richmenu / Flex / Imagemap 特殊處理） | ~500 |
| `flow_properties.js` | 右側屬性面板 `showNodeProperties()` | ~400 |
| `flow_persistence.js` | localStorage / API 儲存載入 | ~200 |
| `flow_designer.js` | 主 class，引入以上模組 | ~500 |

---

### 問題 2：每次操作全量重渲染

`renderAll()` 清空整個畫布再重建所有 DOM。在 `focusOnNode()`、`selectImagemap()`、Bot 切換、重新載入等場景都會呼叫。

**影響**：節點數超過 20-30 個時，會明顯卡頓（尤其 Flex / Richmenu 節點帶圖片）。

**改進方式**：

```javascript
// 只更新移動/變更的節點
updateNode(nodeId) {
    const node = this.nodes.find(n => n.id === nodeId);
    const oldEl = document.getElementById(nodeId);
    if (oldEl) oldEl.remove();
    this.renderNode(node);
    this.updateConnectedEdges(nodeId);
}
```

---

### 問題 3：事件監聽器洩漏

`makeControlPointDraggable()` 在每次 `renderEdge()` 時，往 `document` 上添加 `mousemove` 和 `mouseup` 監聽器，但沒有在邊被刪除時移除。100 條邊 = 200 個殘留監聽器。

**修復方式**：使用 AbortController 或者在 `deleteEdge()` 時統一清理：

```javascript
makeControlPointDraggable(controlPoint, edge, path, sourceNode) {
    const controller = new AbortController();
    edge._abortController = controller;  // 記在 edge 上

    controlPoint.addEventListener('mousedown', (e) => { ... },
        { signal: controller.signal });
    document.addEventListener('mousemove', (e) => { ... },
        { signal: controller.signal });
    document.addEventListener('mouseup', (e) => { ... },
        { signal: controller.signal });
}

deleteEdge(edgeId) {
    const edge = this.edges.find(e => e.id === edgeId);
    if (edge?._abortController) edge._abortController.abort();
    // ... 其餘刪除邏輯
}
```

---

### 問題 4：`flow_theme.css` 全部使用 `.drawflow-*` 類名

**檔案**：`css/flow_theme.css`

整個 CSS 檔案都是針對 `drawflow` 函式庫的類名（`.drawflow-node`、`.drawflow .connection`），但實際程式碼完全沒用 drawflow 函式庫，用的是自訂的 `.flow-node` 類名。

**結果**：這個 CSS 檔案**完全沒有作用**，103 行全是死碼。

**修復方式**：重寫為使用實際的類名（`.flow-node`、`.node-trigger`、`.edge-path` 等），或直接刪除此檔案。

---

## 四、使用者體驗改進

### UX 1：Undo/Redo（復原/重做）

目前刪除節點後無法復原，這是最常見的使用者抱怨。

**實作建議**：

```javascript
class HistoryManager {
    constructor(maxSteps = 50) {
        this.undoStack = [];
        this.redoStack = [];
        this.maxSteps = maxSteps;
    }

    push(state) {
        this.undoStack.push(JSON.stringify(state));
        if (this.undoStack.length > this.maxSteps) this.undoStack.shift();
        this.redoStack = [];  // 新操作清空 redo
    }

    undo() {
        if (this.undoStack.length === 0) return null;
        const current = this.undoStack.pop();
        this.redoStack.push(current);
        return this.undoStack.length > 0
            ? JSON.parse(this.undoStack[this.undoStack.length - 1])
            : null;
    }

    redo() {
        if (this.redoStack.length === 0) return null;
        const state = this.redoStack.pop();
        this.undoStack.push(state);
        return JSON.parse(state);
    }
}
```

快捷鍵：Ctrl+Z（復原）、Ctrl+Shift+Z（重做）

---

### UX 2：小地圖（Minimap）

流程圖複雜時，使用者容易迷失方向。

**實作建議**：在畫布右下角添加一個 150x100px 的縮略圖，顯示所有節點的位置和當前視口框。

```javascript
renderMinimap() {
    const canvas = document.getElementById('minimap-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 計算全部節點的邊界
    const bounds = this.getNodesBounds();
    const scale = Math.min(
        canvas.width / (bounds.width + 200),
        canvas.height / (bounds.height + 200)
    );

    // 畫每個節點的小方塊
    this.nodes.forEach(node => {
        ctx.fillStyle = node.config.color;
        ctx.fillRect(
            (node.position.x - bounds.minX) * scale,
            (node.position.y - bounds.minY) * scale,
            10, 6
        );
    });

    // 畫當前視口框
    ctx.strokeStyle = '#3498db';
    ctx.lineWidth = 2;
    ctx.strokeRect(
        (this.container.scrollLeft / this.canvasZoom - bounds.minX) * scale,
        (this.container.scrollTop / this.canvasZoom - bounds.minY) * scale,
        (this.container.clientWidth / this.canvasZoom) * scale,
        (this.container.clientHeight / this.canvasZoom) * scale
    );
}
```

---

### UX 3：節點搜尋

目前沒有辦法快速定位特定節點（例如找到某個 Richmenu 或特定關鍵字）。

**實作建議**：Ctrl+P 開啟搜尋列（類似 VS Code），輸入關鍵字即時篩選節點。

---

### UX 4：自動對齊/排列

節點拖拽後通常排列凌亂。

**實作建議**：
- 拖曳時顯示智慧對齊線（snap to grid / snap to node）
- 提供「自動排列」按鈕，使用簡單的分層佈局演算法（BFS 按深度分層，每層等距排列）

---

### UX 5：複製/貼上節點

目前完全不支援 Ctrl+C / Ctrl+V。

```javascript
copyNode() {
    if (!this.selectedNode) return;
    const node = this.nodes.find(n => n.id === this.selectedNode);
    this.clipboard = JSON.parse(JSON.stringify(node));
    toast.success('節點已複製');
}

pasteNode() {
    if (!this.clipboard) return;
    const newNode = {
        ...this.clipboard,
        id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        position: {
            x: this.clipboard.position.x + 50,
            y: this.clipboard.position.y + 50
        }
    };
    this.nodes.push(newNode);
    this.renderNode(newNode);
    this.saveToLocalStorage();
}
```

---

## 五、後端改進

### 後端 1：缺少流程驗證

`handleSaveFlow` 直接將前端傳來的 nodes/edges 存入 KV，沒有任何驗證。攻擊者可以存入巨大的 JSON payload 塞爆 KV。

**改進**：

```javascript
// 加入基本驗證
if (JSON.stringify(body).length > 1024 * 512) {
    return jsonResponse({ error: "Flow data too large (max 512KB)" }, 400);
}
if ((nodes || []).length > 200) {
    return jsonResponse({ error: "Too many nodes (max 200)" }, 400);
}
```

### 後端 2：缺少流程版本控制

目前儲存是直接覆蓋，沒有版本歷史。一旦不小心覆蓋了之前的流程，無法恢復。

**改進**：每次 save 時額外保留最近 N 個版本：

```javascript
// 保存版本歷史
const versionKey = `flow_version_${userId}_${botId}_${flowId}_${Date.now()}`;
await env.KV_LINE_STORAGE.put(versionKey, JSON.stringify(flowData), {
    expirationTtl: 60 * 60 * 24 * 30  // 30 天後自動過期
});
```

---

## 六、程式碼品質

### 品質 1：HTML 中的轉義實體

`renderFlexPreview()` 裡（約第 1828 行起），HTML 標籤被寫成了帶空格的轉義形式：

```javascript
preview += `< div style = "..." >📷 Hero 圖片</div > `;
```

這不是合法的 HTML，`< div` 不等於 `<div>`，所以這段預覽功能其實完全壞掉了。

---

### 品質 2：重複的 CSS（HTML `<style>` 區塊）

`flow_designer_full.html` 中，`.flow-node.multi-selected` 的 CSS 規則被重複定義了 8 次。

---

### 品質 3：混用兩套連線機制

存在兩套獨立的連線拖曳系統：
- **機制 A**：`startConnection()` → `updateTempConnection()` → `finishConnection()`（由 node-output-point 按鈕的 onclick 觸發）
- **機制 B**：`startConnectionDrag()` → `updateConnectionDrag()` → `endConnectionDrag()`（由 node-connector 的 mousedown 觸發）

兩套做同樣的事，但實作細節不同，容易造成 state 衝突。應該統一成一套。

---

## 七、改進優先順序

| 優先級 | 項目 | 預估工時 |
|--------|------|---------|
| 🔴 P0 | 修 Bug 1-4（重複輸出點、循環檢測、Focus 座標飄移、Z 鍵衝突） | 2h |
| 🔴 P0 | 實作四個節點選擇器（Richmenu/Flex/Imagemap/Keyword） | 4h |
| 🟡 P1 | 流程列表管理 UI（載入/刪除/重新命名） | 3h |
| 🟡 P1 | 統一兩套連線機制 | 2h |
| 🟡 P1 | 修復 renderFlexPreview 的 HTML 轉義問題 | 0.5h |
| 🟡 P1 | 清理 flow_theme.css（全是死碼） | 0.5h |
| 🟢 P2 | Undo/Redo | 3h |
| 🟢 P2 | 修復事件監聽器洩漏 | 1h |
| 🟢 P2 | 節點搜尋 (Ctrl+P) | 2h |
| 🟢 P2 | 複製/貼上節點 | 1h |
| 🔵 P3 | 拆分 flow_designer.js 為多模組 | 4h |
| 🔵 P3 | Minimap | 3h |
| 🔵 P3 | 自動對齊/排列 | 3h |
| 🔵 P3 | 後端驗證 + 版本控制 | 2h |
| 🔵 P3 | Condition/API 節點編輯器 | 4h |
