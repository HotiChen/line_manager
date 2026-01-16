# 🎨 無限畫布與平移功能

**更新時間**: 2025-12-14 09:39  
**功能**: 無限畫布 + 空白處拖曳平移

---

## ✅ **完成功能**

### 1. **無限畫布** 🗺️
- 畫布大小: 5000 x 5000 像素
- 可捲動（overflow: auto）
- 網格背景延伸整個畫布
- 初始位置置中

### 2. **空白處拖曳平移** 🖐️
- 點擊空白區域按住拖曳
- 游標變化：grab → grabbing
- 平滑移動整個工作區
- 不影響節點拖曳

### 3. **視覺反饋** ✨
- 游標：抓取手勢
- 拖曳時：抓住手勢
- 清晰的互動提示

---

## 🎯 **使用方法**

### 平移畫布
1. 將滑鼠移到**空白處**（不是節點）
2. 游標變為 **抓取手勢** 👋
3. 按住滑鼠左鍵
4. 拖曳移動
5. 🎉 整個畫布跟著移動！

### 捲動畫布
- **滾輪**: 上下捲動
- **Shift + 滾輪**: 左右捲動
- **滾動條**: 直接拖曳

### 移動節點 vs 平移畫布
```
點擊節點 → 移動節點
點擊空白處 → 移動畫布
```

---

## 📐 **畫布規格**

### 尺寸
- **寬度**: 5000px
- **高度**: 5000px
- **網格**: 20px × 20px
- **視窗**: 根據瀏覽器大小

### 初始位置
- 自動置中
- scrollLeft = (5000 - 視窗寬度) / 2
- scrollTop = (5000 - 視窗高度) / 2

### 可用空間
```
┌────────────────────────────────────┐
│                                    │
│     [視窗可見區域]                  │
│        ↕                           │
│    5000px高                        │
│        ↕                           │
│                                    │
└────────────────────────────────────┘
        ←─── 5000px寬 ───→
```

---

## 💻 **技術實作**

### HTML 結構
```html
<div id="flow-canvas">  <!-- 可捲動容器 -->
    <div id="canvas-content">  <!-- 5000x5000 大畫布 -->
        <svg id="connections-layer"></svg>  <!-- 連線層 -->
        <div class="flow-node">...</div>  <!-- 節點 -->
        <div class="flow-node">...</div>
    </div>
</div>
```

### CSS
```css
#flow-canvas {
    overflow: auto;  /* 可捲動 */
    cursor: grab;    /* 抓取手勢 */
}

#flow-canvas.panning {
    cursor: grabbing;  /* 拖曳中 */
}

#canvas-content {
    width: 5000px;   /* 大畫布 */
    height: 5000px;
    position: relative;
}
```

### JavaScript - 平移邏輯
```javascript
setupCanvasPanning() {
    let isPanning = false;
    let startX, startY, scrollLeft, scrollTop;

    // 滑鼠按下
    this.container.addEventListener('mousedown', (e) => {
        // 只在點擊空白處時觸發
        if (e.target === this.container || e.target === this.canvasContent) {
            isPanning = true;
            startX = e.clientX;
            startY = e.clientY;
            scrollLeft = this.container.scrollLeft;
            scrollTop = this.container.scrollTop;
        }
    });

    // 滑鼠移動
    document.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        // 反向移動 = 拖曳效果
        this.container.scrollLeft = scrollLeft - dx;
        this.container.scrollTop = scrollTop - dy;
    });

    // 滑鼠放開
    document.addEventListener('mouseup', () => {
        isPanning = false;
    });
}
```

---

## 🎮 **互動體驗**

### 平移畫布
```
1. 移到空白處
   ↓
2. 游標變為 grab 👋
   ↓
3. 按住滑鼠
   ↓
4. 游標變為 grabbing 👊
   ↓
5. 拖曳移動
   ↓
6. 畫布平移！
```

### 移動節點
```
1. 移到節點上
   ↓
2. 游標變為 move ✋
   ↓
3. 按住拖曳
   ↓
4. 節點移動，連線跟隨
```

---

## 📊 **空間規劃建議**

### 節點佈局
```
┌─────────────────────────────────────┐
│  [起始區]                            │
│    ○ Richmenu 1                     │
│    ○ Richmenu 2                     │
│                                     │
│         [處理區]                     │
│           ○ Flex                    │
│           ○ Text                    │
│                                     │
│                [結束區]              │
│                  ○ End              │
└─────────────────────────────────────┘
```

### 建議配置
- **左側**: 觸發器（Richmenu, Keyword）
- **中間**: 訊息節點（Flex, Text）
- **右側**: 動作、結束節點

---

## 🔧 **快捷鍵（未來）**

### 計劃中的功能
- **Space + 拖曳**: 平移畫布（手動模式）
- **Ctrl + 滾輪**: 縮放畫布
- **Ctrl + 0**: 重置縮放
- **Ctrl + F**: 置中視圖

---

## 💡 **使用技巧**

### 技巧 1: 快速導航
- 用滾動條快速跳到不同區域
- 拖曳平移微調位置

### 技巧 2: 組織節點
- 類似功能的節點放在一起
- 留出足夠空間給連線

### 技巧 3: 初始佈局
- 從畫布中央開始
- 向外擴展流程

---

## 🎉 **立即體驗**

訪問流程設計器：
```
http://localhost:8787/pages/flow_designer.html
```

**試試看**：
1. 點擊空白處拖曳 → 畫布移動
2. 用滾輪捲動 → 瀏覽不同區域
3. 新增多個節點 → 充分利用空間
4. 🎨 **享受無限畫布！**

---

## 📝 **已知限制**

### 目前的限制
- 畫布固定 5000×5000（未來可擴展到無限）
- 無縮放功能（計劃中）
- 無小地圖（計劃中）

### 未來改進
- [ ] 動態擴展畫布
- [ ] Ctrl + 滾輪縮放
- [ ] 小地圖導航
- [ ] 雙擊置中
- [ ] 框選多個節點

---

**享受寬敞的工作空間！** 🎨
