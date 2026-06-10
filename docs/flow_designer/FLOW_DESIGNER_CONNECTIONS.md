# 🔗 連線功能完整實作

**更新時間**: 2025-12-14 09:28  
**功能**: 完整的拖曳連線系統

---

## ✅ **已完成功能**

### 1. **拖曳連線** 🎯
- 點擊連接點開始拖曳
- 滑鼠移動時顯示臨時連線（虛線）
- 放開滑鼠完成連接
- ESC 鍵取消連線

### 2. **視覺化連線** 🎨
- 使用 SVG 貝茲曲線繪製
- 顏色與起始節點一致
- 平滑的曲線效果
- Hover 變紅色+變粗

### 3. **連線管理** ⚙️
- 自動防止重複連線
- 循環檢測（防止A→B→A）
- 點擊連線可刪除
- 連線資料儲存到 LocalStorage

### 4. **智能提示** 💬
- Toast 通知連線結果
- 成功: "✅ 已連接: A → B"
- 警告: "該連線已存在"
- 錯誤: "無法創建循環連線"

---

## 🎨 **視覺效果**

```
     [ 節點 A ]
          │     ╭─虛線（拖曳中）
          ●─────╯
          │
          ↓
     實線曲線（完成）
          │
          ↓
     [ 節點 B ]
```

### 連線狀態：

**拖曳中**:
- 虛線（stroke-dasharray: 5,5）
- 跟隨滑鼠移動
- 游標變為十字

**完成後**:
- 實線
- 節點顏色
- 可以點擊

**Hover 時**:
- 變紅色 (#e74c3c)
- 加粗（3px）
- 顯示刪除提示

---

## 🚀 **使用方法**

### 創建連線
1. 點擊任一節點的**連接點**（圓形）
2. 拖曳到目標節點
3. 放開滑鼠
4. ✅ 連線創建！

### 刪除連線
1. 點擊連線路徑
2. 確認刪除
3. ✅ 連線刪除！

### 取消連線
- 正在拖曳時按 **ESC** 鍵
- 或放開滑鼠到空白處

---

## 📊 **技術實作**

### SVG 圖層
```javascript
// 創建 SVG 容器
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;  // 允許點擊穿透到節點
    z-index: 1;
`;
```

### 貝茲曲線路徑
```javascript
// M: MoveTo（起點）
// C: CurveTo（貝茲曲線）
// 格式: M x1 y1 C cpx1 cpy1, cpx2 cpy2, x2 y2

createCurvePath(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1);
    const offset = Math.min(dx / 2, 100);
    
    return `M ${x1} ${y1} C ${x1 + offset} ${y1}, ${x2 - offset} ${y2}, ${x2} ${y2}`;
}
```

### 循環檢測算法
```javascript
// 廣度優先搜尋（BFS）
wouldCreateCycle(sourceId, targetId) {
    const visited = new Set();
    const queue = [targetId];
    
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === sourceId) return true;  // 找到循環！
        if (visited.has(current)) continue;
        
        visited.add(current);
        
        // 找到所有從 current 出發的連線
        this.edges.forEach(edge => {
            if (edge.source === current) {
                queue.push(edge.target);
            }
        });
    }
    
    return false;  // 無循環
}
```

---

## 💾 **資料結構**

### Edge (連線)
```json
{
    "id": "edge_1702518486789",
    "source": "node_1",          // 起始節點 ID
    "sourceHandle": "btn_0",     // 起始連接點（Richmenu 按鈕）
    "target": "node_2",           // 目標節點 ID
    "targetHandle": "input"       // 目標連接點
}
```

### 完整流程資料
```json
{
    "nodes": [ /* 節點陣列 */ ],
    "edges": [
        {
            "id": "edge_1",
            "source": "node_richmenu",
            "sourceHandle": "btn_faq",
            "target": "node_flex",
            "targetHandle": "input"
        },
        {
            "id": "edge_2",
            "source": "node_flex",
            "sourceHandle": "default",
            "target": "node_text",
            "targetHandle": "input"
        }
    ]
}
```

---

## 🎯 **連線驗證規則**

### ✅ 允許的連線
- A → B（正常連接）
- A → B, B → C（鏈式連接）
- A → C, B → C（合併連接）
- Richmenu 不同按鈕 → 不同節點

### ❌ 禁止的連線
- A → A（自己連自己）
- A → B → A（循環）
- A → B（重複，已存在相同連線）

---

## 🎨 **互動體驗**

### 拖曳連線
1. **點擊連接點**
   - 游標變為十字
   - 虛線出現
   
2. **移動滑鼠**
   - 虛線跟隨滑鼠
   - 貝茲曲線平滑過渡
   
3. **完成連接**
   - Toast 顯示成功訊息
   - 實線替換虛線
   - 游標恢復

### Hover 連線
- 滑鼠懸停 → 紅色加粗
- 滑鼠離開 → 恢復原色

### 點擊連線
- 顯示確認對話框
- 確認後刪除
- Toast 通知

---

## 🔧 **事件處理**

### 滑鼠事件流程
```
點擊連接點
    ↓
startConnection()
    ↓
創建臨時 SVG path
    ↓
監聽 mousemove
    ↓
updateTempConnection()
    ↓
監聽 mouseup
    ↓
finishConnection()
    ↓
檢查目標節點
    ↓
驗證連線
    ↓
createEdge()
    ↓
renderEdge()
    ↓
儲存到 LocalStorage
```

### 鍵盤事件
- **ESC**: 取消連線
- **Delete**: 刪除選中節點（cascade 刪除連線）

---

## 📝 **使用範例**

### 創建客服流程
```
1. 新增 Richmenu「主選單」
2. 新增 Flex「FAQ 列表」
3. 點擊 Richmenu 的「常見問題」按鈕連接點
4. 拖曳到 Flex 節點
5. 放開滑鼠
6. ✅ 連線建立！

結果:
[ Richmenu: 主選單 ]
    ●── (常見問題) ──→ [ Flex: FAQ 列表 ]
```

### 多分支流程
```
[ Richmenu: 主選單 ]
    ●── (FAQ) ──────→ [ Flex: FAQ ]
    ●── (聯絡) ─────→ [ Text: 聯絡資訊 ]
    ●── (關於) ─────→ [ Imagemap: 關於我們 ]
```

---

## 🐛 **錯誤處理**

### 防止重複連線
```javascript
const exists = this.edges.some(e => 
    e.source === sourceId && 
    e.sourceHandle === sourceHandle && 
    e.target === targetId
);

if (exists) {
    toast.warning('該連線已存在');
    return;
}
```

### 防止循環
```javascript
if (this.wouldCreateCycle(sourceId, targetId)) {
    toast.error('無法創建循環連線');
    return;
}
```

---

## 🎉 **立即體驗**

訪問流程設計器：
```
http://localhost:8787/pages/flow_designer.html
```

**試試看**：
1. 新增兩個節點（Richmenu + Flex）
2. 載入資料
3. 點擊 Richmenu 的紅色連接點
4. 拖曳到 Flex 節點
5. 🎉 **看到美麗的連線！**

---

## 💡 **進階功能（未來）**

- [ ] 連線標籤（顯示條件）
- [ ] 連線動畫（流動效果）
- [ ] 連線編輯（修改目標）
- [ ] 連線顏色自定義
- [ ] 多選連線刪除
- [ ] 連線統計

---

**完整的流程設計器體驗！** 🚀
