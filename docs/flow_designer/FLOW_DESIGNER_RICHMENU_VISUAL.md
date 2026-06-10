# 🎨 Richmenu 節點視覺化更新

**更新時間**: 2025-12-14 03:20  
**功能**: Richmenu 節點現在會顯示選單圖片！

---

## ✅ 已完成的改進

### 1. **節點自動調整大小**
- Richmenu 有圖片時：`min-width: 250px`
- 其他節點：`min-width: 180px`
- 最大寬度：`max-width: 300px`

### 2. **圖片顯示**
Richmenu 節點會顯示：
- ✅ Richmenu 圖片預覽
- ✅ 選單名稱
- ✅ 按鈕數量

### 3. **自動重新渲染**
當你選擇 Richmenu 並點擊「載入」後：
1. 載入 Richmenu 詳細資料（包含圖片）
2. 自動移除舊節點
3. 重新渲染新節點（含圖片）
4. 更新屬性面板

---

## 📊 視覺效果對比

### Before ❌
```
┌─────────────────┐
│ 🎯 Richmenu     │
├─────────────────┤
│ 主選單          │
└─────────────────┘
```

### After ✨
```
┌───────────────────────┐
│ 🎯 Richmenu           │
├───────────────────────┤
│ ┌─────────────────┐   │
│ │                 │   │ ← Richmenu 圖片！
│ │   [選單圖片]    │   │
│ │                 │   │
│ └─────────────────┘   │
├───────────────────────┤
│ 主選單                │
│ 3 個按鈕              │
└───────────────────────┘
```

---

## 🚀 如何使用

### 步驟 1: 新增 Richmenu 節點
右鍵點擊畫布 → 選擇「新增 Richmenu」

### 步驟 2: 選擇 Richmenu
1. 點擊節點
2. 在右側屬性面板選擇 Richmenu
3. 點擊「載入 Richmenu」按鈕

### 步驟 3: 自動顯示圖片
節點會自動：
- 變寬以容納圖片
- 顯示 Richmenu 圖片
- 顯示選單名稱和按鈕數量

---

## 🎯 技術細節

### 節點渲染邏輯
```javascript
// 根據節點類型調整寬度
const minWidth = node.type === NodeTypes.RICHMENU && node.data.imageUrl 
    ? '250px'   // 有圖片
    : '180px';  // 無圖片

// 特殊處理：Richmenu 節點顯示圖片
if (node.type === NodeTypes.RICHMENU && node.data.imageUrl) {
    innerHTML += `
        <div style="margin-bottom: 8px;">
            <img src="${node.data.imageUrl}" 
                 style="width: 100%; height: auto; border-radius: 4px;">
        </div>
        <div><strong>${node.data.name}</strong></div>
        <div>${node.data.buttons.length} 個按鈕</div>
    `;
}
```

### 載入流程
```javascript
async selectRichmenu(nodeId) {
    // 1. 獲取 Richmenu ID
    const richMenuId = selectElement.value;
    
    // 2. 載入詳細資料（包含圖片）
    const details = await dataLoader.loadRichmenuDetails(richMenuId);
    
    // 3. 更新節點資料
    node.data.imageUrl = details.imageUrl;  // ✅ 儲存圖片
    
    // 4. 重新渲染節點
    nodeElement.remove();
    this.renderNode(node);
}
```

---

## 📝 資料結構

### Richmenu 節點資料
```javascript
{
    richmenuId: "richmenu_123",
    name: "主選單",
    imageUrl: "blob:http://localhost:8787/...",  // ✅ 新增！
    buttons: [
        { id: "btn_0", label: "💬 常見問題", ... },
        { id: "btn_1", label: "🔗 聯絡客服", ... },
        { id: "btn_2", label: "📦 關於我們", ... }
    ]
}
```

---

## 🎨 樣式說明

### 圖片樣式
- **寬度**: 100% (自適應容器)
- **高度**: auto (保持比例)
- **圓角**: 4px
- **邊框**: 1px solid #ddd

### 節點樣式
- **最小寬度**: 250px (有圖片) / 180px (無圖片)
- **最大寬度**: 300px
- **內邊距**: 12px
- **邊框**: 2px solid (根據類別顏色)
- **陰影**: 0 2px 8px rgba(0,0,0,0.1)

---

## 🔧 未來改進

### 可選改進：
- [ ] 添加圖片懶加載
- [ ] 支援圖片放大預覽（點擊放大）
- [ ] 顯示圖集尺寸資訊
- [ ] 添加載入動畫
- [ ] 支援拖放更換圖片

---

## 🎉 效果預覽

訪問流程設計器：
```
http://localhost:8787/pages/flow_designer.html
```

1. 右鍵新增 Richmenu 節點
2. 選擇任一 Richmenu
3. 點擊「載入」
4. 🎨 **看到美美的圖片！**

---

**享受視覺化的流程設計體驗！** ✨
