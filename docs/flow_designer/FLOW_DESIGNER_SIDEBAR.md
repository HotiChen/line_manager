# 🎛️ 側邊欄控制功能

**更新時間**: 2025-12-14 10:04  
**功能**: 顯示/隱藏節點屬性面板

---

## ✅ **完成功能**

### 1. **工具列按鈕** 🔘
在右上角工具列新增側邊欄切換按鈕：
- 圖示：📐 (layout-sidebar-reverse)
- 位置：測試按鈕旁邊
- 功能：一鍵切換側邊欄

### 2. **側邊欄關閉按鈕** ✖️
在側邊欄標題旁新增關閉按鈕：
- 圖示：✖️ (x-lg)
- 位置：「節點屬性」標題右側
- 功能：關閉側邊欄

### 3. **切換功能** 🔄
- 點擊工具列按鈕 → 切換顯示/隱藏
- 點擊側邊欄關閉按鈕 → 隱藏
- 選擇節點 → 自動顯示
- CSS transition 平滑動畫

---

## 🎨 **視覺效果**

### 工具列（更新後）
```
┌────────────────────────────────────────┐
│ 🎨 LINE Bot 流程設計器                  │
│                                        │
│  [新建] [載入] [儲存] [測試] [📐]      │ ← 新增切換按鈕
└────────────────────────────────────────┘
```

### 側邊欄（更新後）
```
┌─────────────────┐
│ 節點屬性    [✖️] │ ← 新增關閉按鈕
├─────────────────┤
│ 🎯 Richmenu     │
│                 │
│ 選擇 Richmenu   │
│ [下拉選單]      │
│                 │
│ [刪除節點]      │
└─────────────────┘
```

---

## 🚀 **使用方法**

### 方法 1: 工具列按鈕
```
1. 點擊右上角的 📐 按鈕
2. 側邊欄滑入/滑出
3. 再次點擊切換回來
```

### 方法 2: 側邊欄關閉按鈕
```
1. 側邊欄打開時
2. 點擊標題旁的 ✖️ 按鈕
3. 側邊欄滑出隱藏
```

### 方法 3: 選擇節點自動顯示
```
1. 側邊欄關閉狀態
2. 點擊任一節點
3. 側邊欄自動滑入顯示
4. 顯示該節點的屬性
```

---

## 💡 **使用場景**

### 場景 1: 需要更多畫布空間
```
1. 完成節點配置
2. 點擊 📐 關閉側邊欄
3. 獲得更大的工作區域
4. 專注於流程佈局
```

### 場景 2: 快速編輯多個節點
```
1. 保持側邊欄開啟
2. 依次點擊節點
3. 側邊欄自動切換顯示對應屬性
4. 快速編輯每個節點
```

### 場景 3: 展示模式
```
1. 流程設計完成
2. 關閉側邊欄
3. 畫面更整潔
4. 適合截圖或展示
```

---

## 🎯 **互動行為**

### 狀態切換
```
隱藏 → 點擊按鈕 → 顯示
顯示 → 點擊按鈕 → 隱藏
隱藏 → 選擇節點 → 顯示（自動）
```

### 動畫效果
```
CSS transition: transform 0.3s
滑入：transform: translateX(0)
滑出：transform: translateX(100%)
```

---

## 💻 **技術實作**

### HTML 結構（工具列）
```html
<button class="btn btn-sm btn-outline-light" 
        onclick="flowDesigner.toggleSidebar()" 
        title="顯示/隱藏屬性面板">
    <i class="bi bi-layout-sidebar-reverse"></i>
</button>
```

### HTML 結構（側邊欄）
```html
<div id="sidebar">
    <div class="d-flex justify-content-between align-items-center mb-3">
        <h6 class="mb-0">節點屬性</h6>
        <button class="btn btn-sm btn-outline-secondary" 
                onclick="flowDesigner.toggleSidebar()" 
                title="關閉">
            <i class="bi bi-x-lg"></i>
        </button>
    </div>
    <div id="node-properties">
        ...
    </div>
</div>
```

### CSS 樣式
```css
#sidebar {
    position: fixed;
    right: 0;
    top: 60px;
    bottom: 0;
    width: 300px;
    background: white;
    transform: translateX(100%);  /* 預設隱藏 */
    transition: transform 0.3s;
}

#sidebar.show {
    transform: translateX(0);  /* 顯示 */
}
```

### JavaScript
```javascript
// 切換顯示/隱藏
toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('show');
}

// 隱藏
hideSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.remove('show');
}

// 顯示節點屬性（自動開啟側邊欄）
showNodeProperties(nodeId) {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.add('show');  // 自動顯示
    // ... 更新內容
}
```

---

## 🎨 **視覺設計**

### 工具列按鈕
- 樣式：`btn-outline-light`
- 顏色：白色外框（配合深色工具列）
- 圖示：Bootstrap Icons `bi-layout-sidebar-reverse`
- Tooltip：「顯示/隱藏屬性面板」

### 側邊欄關閉按鈕
- 樣式：`btn-sm btn-outline-secondary`
- 顏色：灰色外框
- 圖示：Bootstrap Icons `bi-x-lg`
- Tooltip：「關閉」

---

## 📊 **狀態管理**

### 側邊欄狀態
| 狀態 | CSS Class | Transform | 可見性 |
|------|-----------|-----------|--------|
| 隱藏 | 無 | translateX(100%) | ❌ |
| 顯示 | `.show` | translateX(0) | ✅ |

### 觸發顯示的情況
1. 點擊工具列按鈕（狀態為隱藏時）
2. 點擊任一節點
3. 選擇並載入資料後

### 觸發隱藏的情況
1. 點擊工具列按鈕（狀態為顯示時）
2. 點擊側邊欄關閉按鈕

---

## 💡 **使用技巧**

### 技巧 1: 快捷鍵（未來）
```
計劃中：
- P 鍵：切換屬性面板
- Esc：關閉屬性面板
```

### 技巧 2: 工作流程
```
編輯階段：
1. 側邊欄開啟
2. 快速配置節點

佈局階段：
1. 側邊欄關閉
2. 專注於流程設計
3. 需要時再開啟
```

### 技巧 3: 螢幕空間優化
```
小螢幕：
- 預設關閉側邊欄
- 需要時才開啟

大螢幕：
- 可以常開
- 有足夠空間
```

---

## 🎯 **按鈕位置**

### 工具列佈局
```
┌────────────────────────────────────────┐
│  [新建][載入][儲存][測試]    [📐]       │
│  ←─────功能按鈕──────→  ←切換→         │
└────────────────────────────────────────┘
```

### 側邊欄標題
```
┌───────────────────┐
│ 節點屬性      [✖️] │
│ ←標題→     ←關閉→  │
└───────────────────┘
```

---

## 🎉 **立即體驗**

訪問流程設計器：
```
http://localhost:8787/pages/flow_designer.html
```

### 測試步驟
```
1. 頁面載入後，側邊欄是隱藏的
2. 點擊右上角 📐 按鈕
3. 🎉 側邊欄滑入！
4. 點擊側邊欄的 ✖️ 按鈕
5. 🎉 側邊欄滑出！
6. 點擊任一節點
7. 🎉 側邊欄自動滑入並顯示屬性！
```

---

## 📝 **更新內容**

### 新增功能
- ✅ 工具列切換按鈕
- ✅ 側邊欄關閉按鈕
- ✅ `toggleSidebar()` 函數
- ✅ `hideSidebar()` 函數
- ✅ 平滑動畫效果

### 保持原有功能
- ✅ 點擊節點自動顯示側邊欄
- ✅ 節點屬性編輯功能
- ✅ CSS transition 動畫

---

## 🔧 **未來改進**

### 計劃功能
- [ ] 鍵盤快捷鍵支援
- [ ] 記憶側邊欄狀態（LocalStorage）
- [ ] 可調整側邊欄寬度
- [ ] 側邊欄停靠位置切換（左/右）

---

**享受更靈活的工作空間！** 🎛️
