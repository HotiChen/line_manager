# 👆 觸控手勢支援

**更新時間**: 2025-12-14 09:54  
**功能**: 觸控板 + 觸控螢幕手勢

---

## ✅ **支援的手勢**

### 1. **雙指縮放**（Pinch to Zoom）👆👇
**適用於**: 觸控板、觸控螢幕
- 雙指張開 = 放大
- 雙指收合 = 縮小
- 即時縮放反饋
- 平滑的縮放動畫

### 2. **Ctrl + 滾輪縮放** 🖱️
**適用於**: 滑鼠、觸控板
- Ctrl + 滾輪向上 = 放大
- Ctrl + 滾輪向下 = 縮小
- **以滑鼠位置為中心**縮放
- 自動調整視圖位置

### 3. **觸控拖曳** 👆
**適用於**: 觸控螢幕
- 單指拖曳 = 平移畫布
- 雙指拖曳 = 縮放

---

## 🎯 **使用方法**

### MacBook 觸控板
```
雙指縮放：
1. 雙指放在觸控板上
2. 張開雙指 → 放大
3. 收合雙指 → 縮小
4. ✨ 畫布即時縮放！

Ctrl + 滾輪：
1. 按住 Ctrl
2. 雙指上下滑動
3. ✨ 以游標為中心縮放！
```

### iPad / 觸控螢幕
```
雙指縮放：
1. 雙指觸碰螢幕
2. 張開 → 放大
3. 捏合 → 縮小
4. ✨ 直覺的手勢縮放！
```

### 滑鼠
```
Ctrl + 滾輪：
1. 按住 Ctrl
2. 滾輪向上 → 放大
3. 滾輪向下 → 縮小
4. ✨ 滑鼠位置保持固定！
```

---

## 🎨 **手勢體驗**

### 雙指縮放
```
觸控板/觸控螢幕：
   ↗️  ↖️
  👆    👆   ← 張開雙指 = 放大
   🖼️
  👆    👆   ← 收合雙指 = 縮小
   ↘️  ↙️

即時反饋：
- 縮放跟隨手指動作
- 平滑的視覺過渡
- 結束時顯示最終比例
```

### Ctrl + 滾輪
```
滑鼠位置：
        ↑ 滾輪向上
       🖱️  ← 滑鼠指標
        ↓ 滾輪向下

縮放效果：
- 以滑鼠為中心放大/縮小
- 滑鼠下的內容保持固定
- 自然的縮放體驗
```

---

## 💻 **技術實作**

### 雙指縮放檢測
```javascript
// 觸控開始：記錄雙指距離
touchstart: (e) => {
    if (e.touches.length === 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        
        // 計算兩指距離
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        initialDistance = Math.sqrt(dx * dx + dy * dy);
        initialZoom = this.canvasZoom;
    }
}

// 觸控移動：計算縮放比例
touchmove: (e) => {
    if (e.touches.length === 2) {
        const currentDistance = calculateDistance(e.touches);
        const scale = currentDistance / initialDistance;
        
        // 應用縮放
        this.canvasZoom = initialZoom * scale;
        this.applyCanvasZoom();
    }
}
```

### 滾輪縮放（以滑鼠為中心）
```javascript
wheel: (e) => {
    if (e.ctrlKey) {
        e.preventDefault();
        
        // 計算滑鼠位置
        const rect = this.container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        // 縮放前的滾動位置
        const oldScrollX = this.container.scrollLeft;
        const oldScrollY = this.container.scrollTop;
        
        // 應用縮放
        this.applyCanvasZoom();
        
        // 調整滾動位置，保持滑鼠下的內容不變
        const zoomRatio = newZoom / oldZoom;
        this.container.scrollLeft = (oldScrollX + mouseX) * zoomRatio - mouseX;
        this.container.scrollTop = (oldScrollY + mouseY) * zoomRatio - mouseY;
    }
}
```

---

## 📊 **手勢對比**

| 手勢 | 裝置 | 優點 | 適用場景 |
|------|------|------|---------|
| **雙指縮放** | 觸控板 | 直覺、快速 | MacBook 用戶 |
| **雙指縮放** | 觸控螢幕 | 自然、精確 | iPad、平板 |
| **Ctrl+滾輪** | 滑鼠 | 精確控制 | 桌面編輯 |
| **Ctrl++/-** | 鍵盤 | 固定步進 | 快速調整 |

---

## 🎯 **縮放中心點**

### 雙指縮放
```
中心點：雙指中點
┌─────────────────┐
│     [節點A]     │
│   👆     👆     │ ← 雙指中點為縮放中心
│     [節點B]     │
└─────────────────┘
```

### Ctrl + 滾輪
```
中心點：滑鼠位置
┌─────────────────┐
│     [節點A]     │
│        🖱️       │ ← 滑鼠位置為縮放中心
│     [節點B]     │
└─────────────────┘
```

---

## 💡 **使用技巧**

### 技巧 1: MacBook 觸控板
```
1. 用雙指快速縮放到想要的比例
2. 用單指拖曳平移到想編輯的區域
3. 再次雙指縮放到最佳視角
```

### 技巧 2: iPad / 觸控螢幕
```
1. 雙指張開放大看細節
2. 雙指收合縮小看全局
3. 單指拖曳移動位置
```

### 技巧 3: 滑鼠精確縮放
```
1. 將滑鼠移到想放大的節點上
2. Ctrl + 滾輪向上
3. 節點在滑鼠下方放大
4. 不需要重新平移
```

---

## 🎨 **視覺反饋**

### Toast 通知
```
雙指縮放中：
- 無通知（即時反饋）

雙指縮放結束：
✅ "縮放: 150%"

Ctrl + 滾輪：
✅ "縮放: 120%"  ← 每次縮放都通知
```

### 縮放動畫
```
觸控板/觸控螢幕：
- CSS transform
- 硬體加速
- 60fps 流暢動畫

滾輪：
- 即時縮放
- 位置同步調整
```

---

## 🔧 **進階功能**

### 防止預設行為
```javascript
{ passive: false }  // 允許 preventDefault()

// 防止瀏覽器預設的縮放行為
e.preventDefault();
```

### 縮放範圍限制
```javascript
this.canvasZoom = Math.max(0.25, Math.min(3.0, newZoom));
//                       ↑25%         ↑300%
```

---

## 🎯 **支援平台**

| 平台 | 雙指縮放 | Ctrl+滾輪 | 觸控拖曳 |
|------|---------|----------|---------|
| **macOS** | ✅ | ✅ | ❌ |
| **Windows** | ✅ | ✅ | ❌ |
| **iPad** | ✅ | ❌ | ✅ |
| **Android** | ✅ | ❌ | ✅ |
| **桌面瀏覽器** | ❌ | ✅ | ❌ |

---

## 🚀 **立即體驗**

訪問流程設計器：
```
http://localhost:8787/pages/flow_designer.html
```

### 測試步驟

#### MacBook 測試
```
1. 雙指放在觸控板上
2. 張開雙指
3. 🎉 畫布放大！
4. 收合雙指
5. 🎉 畫布縮小！
```

#### 滑鼠測試
```
1. 按住 Ctrl
2. 滾輪向上
3. 🎉 以滑鼠為中心放大！
4. 滾輪向下
5. 🎉 縮小！
```

---

## 📝 **手勢總表**

| 手勢 | 效果 | 快捷鍵 |
|------|------|--------|
| 👆👆 張開 | 放大 | - |
| 👆👆 收合 | 縮小 | - |
| Ctrl + 🖱️⬆️ | 放大 | - |
| Ctrl + 🖱️⬇️ | 縮小 | - |
| Ctrl + + | 放大 | ✅ |
| Ctrl + - | 縮小 | ✅ |
| Ctrl + 0 | 重置 | ✅ |
| Ctrl + F | 適應螢幕 | ✅ |

---

## 💡 **最佳實踐**

### 桌面編輯
```
推薦：Ctrl + 滾輪
- 精確控制
- 保持滑鼠位置
- 快速調整
```

### MacBook 瀏覽
```
推薦：觸控板雙指縮放
- 最直覺
- 最快速
- 最流暢
```

### iPad 編輯
```
推薦：觸控螢幕手勢
- 自然操作
- 即時反饋
- 精確控制
```

---

**享受流暢的手勢體驗！** 👆✨
