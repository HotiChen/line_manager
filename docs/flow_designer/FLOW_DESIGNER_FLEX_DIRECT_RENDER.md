# 🎨 Flex Message 直接渲染

**更新時間**: 2025-12-14 10:24  
**功能**: 像 Richmenu 一樣直接在節點上顯示完整的 Flex Message

---

## ✅ **改進說明**

### 之前：Modal 彈窗預覽
```
節點顯示簡化摘要
↓
點擊「👁️ 完整預覽」按鈕
↓
彈出 Modal
↓
顯示完整 Flex Message
```

### 現在：直接渲染在節點上
```
節點標題
↓
完整渲染的 Flex Message ✨
- Bubble: 直接顯示
- Carousel: 橫向排列成一長條
```

---

## 🎨 **視覺效果**

### Bubble 類型
```
┌──────────────────────┐
│ 💬 Flex Message      │
├──────────────────────┤
│ FAQ 列表             │
├──────────────────────┤
│ ┏━━━━━━━━━━━━━━━━┓ │
│ ┃ [Hero Banner]   ┃ │
│ ┃                 ┃ │
│ ┃ 常見問題        ┃ │
│ ┃ 1. 如何註冊？   ┃ │
│ ┃ 2. 如何使用？   ┃ │
│ ┃                 ┃ │
│ ┃ [更多問題]      ┃ │
│ ┃ [聯絡客服]      ┃ │
│ ┗━━━━━━━━━━━━━━━━┛ │
│                  ●   │ ← 連接點
└──────────────────────┘
```

### Carousel 類型（橫向排列）
```
┌─────────────────────────────────────────────────────┐
│ 💬 Flex Message                                     │
├─────────────────────────────────────────────────────┤
│ 產品輪播                                             │
├─────────────────────────────────────────────────────┤
│ ┏━━━━━┓ ┏━━━━━┓ ┏━━━━━┓ ┏━━━━━┓ ┏━━━━━┓         │
│ ┃產品1┃ ┃產品2┃ ┃產品3┃ ┃產品4┃ ┃產品5┃  →      │
│ ┃[img]┃ ┃[img]┃ ┃[img]┃ ┃[img]┃ ┃[img]┃ 可橫向捲動│
│ ┃$100 ┃ ┃$200 ┃ ┃$300 ┃ ┃$400 ┃ ┃$500 ┃         │
│ ┗━━━━━┛ ┗━━━━━┛ ┗━━━━━┛ ┗━━━━━┛ ┗━━━━━┛         │
│                                                 ●   │
└─────────────────────────────────────────────────────┘
```

---

## 💡 **技術實作**

### 渲染邏輯
```javascript
// 1. 為 Flex 內容準備容器
const flexContainerId = `flex-container-${node.id}`;
innerHTML += `
    <div id="${flexContainerId}" style="overflow-x: auto;"></div>
`;

// 2. 節點渲染完成後，使用 flex2html 渲染
setTimeout(() => {
    flex2html(flexContainerId, {
        type: 'flex',
        altText: node.data.title,
        contents: node.data.contents
    });
}, 10);
```

### 節點寬度調整
```javascript
// Bubble: 250px (標準寬度)
if (contents.type === 'bubble') {
    baseWidth = 250;
    maxWidth = 300;
}

// Carousel: 最多 800px (容納多張卡片)
if (contents.type === 'carousel') {
    baseWidth = 300;
    maxWidth = 800;
}
```

### 橫向捲動
```css
#flex-container {
    overflow-x: auto;  /* 橫向捲動 */
    max-width: 100%;
}
```

---

## 🎯 **顯示規則**

### Bubble
- 寬度：250px
- 高度：自動
- 滾動：垂直（如果內容太長）

### Carousel
- 寬度：最多 800px
- 高度：自動
- 滾動：**水平** ← 重點！
- 卡片：橫向排列

---

## 🚀 **使用流程**

```
1. 新增 Flex Message 節點
   ↓
2. 選擇並載入 Flex Message
   ↓
3. ✨ 節點自動顯示完整渲染的 Flex！
   - Bubble: 完整顯示
   - Carousel: 橫向排列，可左右滑動
   ↓
4. 從連接點拖曳到其他節點
   ↓
5. 完成流程設計
```

---

## 💡 **優點**

### vs Modal 預覽
| 特性 | Modal 預覽 | 直接渲染 |
|------|-----------|---------|
| 查看方式 | 需要點擊 | **直接顯示** ✨ |
| 流程理解 | 中斷視覺 | **一目了然** ✨ |
| 操作步驟 | 2步驟 | **0步驟** ✨ |
| 畫布空間 | 不占 | 占用 |
| 編輯體驗 | 分離 | **整合** ✨ |

### 像 Richmenu 一樣
```
Richmenu:
- 直接顯示圖片
- 看到按鈕框框
- 所見即所得

Flex Message:  ← 現在也一樣！
- 直接顯示內容
- 看到實際樣式
- 所見即所得 ✨
```

---

## 🎨 **完整範例**

### 客服流程設計
```
畫布視圖：

[ Richmenu: 客服選單 ]
  │ [圖片：8個按鈕]
  │
  ├─ FAQ ●───→ [ Flex: FAQ 列表 ]
  │             │ ┏━━━━━━━━━━━┓
  │             │ ┃ FAQ Banner┃
  │             │ ┃ Q1: ...   ┃
  │             │ ┃ Q2: ...   ┃
  │             │ ┃ [按鈕]    ┃
  │             │ ┗━━━━━━━━━━━┛
  │
  ├─ 產品 ●───→ [ Flex: 產品輪播 ]
  │             │ ┏━┓┏━┓┏━┓┏━┓┏━┓
  │             │ ┃1┃┃2┃┃3┃┃4┃┃5┃ →
  │             │ ┗━┛┗━┛┗━┛┗━┛┗━┛
  │
  └─ 客服 ●───→ [ Flex: 客服資訊 ]
                │ ┏━━━━━━━━━━━┓
                │ ┃ 客服中心  ┃
                │ ┃ 📞 電話   ┃
                │ ┃ 📧 Email  ┃
                │ ┗━━━━━━━━━━━┛
```

---

## 🔧 **技術細節**

### flex2html 調用
```javascript
// 參數1: 容器 ID
// 參數2: Flex Message 物件
flex2html('flex-container-node_123', {
    type: 'flex',
    altText: 'FAQ',
    contents: {
        type: 'bubble',
        hero: { ... },
        body: { ... },
        footer: { ... }
    }
});
```

### 延遲渲染
```javascript
// 確保 DOM 已插入後才渲染
setTimeout(() => {
    flex2html(containerId, flexMessage);
}, 10);
```

### 錯誤處理
```javascript
try {
    if (typeof flex2html !== 'function') {
        console.error('flex2html not loaded');
        return;
    }
    flex2html(containerId, flexMessage);
} catch (error) {
    console.error('Flex 渲染錯誤:', error);
}
```

---

## 🎯 **立即體驗**

訪問流程設計器：
```
http://localhost:8787/pages/flow_designer.html
```

### 測試步驟
```
1. 重新載入頁面
2. 新增 Flex Message 節點
3. 載入一個 Flex Message
4. ✨ 看到節點上直接顯示完整的 Flex！
   - Bubble: 完整內容
   - Carousel: 橫向排列
5. 試試 Carousel 的橫向捲動
6. 從連接點拖曳連線
7. 完整的視覺化流程設計！
```

---

## 💡 **使用技巧**

### 技巧 1: Carousel 捲動
```
滑鼠移到 Carousel 上
→ 橫向滾輪或拖曳
→ 查看所有卡片
```

### 技巧 2: 節點縮放
```
Carousel 太長？
→ 使用 [-] 按鈕縮小節點
→ 節點變小，內容也縮小
→ 更容易看全局
```

### 技巧 3: 快速對比
```
放多個 Flex 節點在畫布上
→ 一眼對比不同的設計
→ 快速選擇最佳方案
```

---

## 🎊 **改進總結**

### 使用體驗
- ✅ **即時顯示** - 載入後立即渲染
- ✅ **所見即所得** - 直接看到完整內容
- ✅ **無需點擊** - 不用開 Modal
- ✅ **流暢設計** - 視覺整合

### 視覺化
- ✅ **完整渲染** - 真實的 Flex 樣式
- ✅ **橫向排列** - Carousel 一長條
- ✅ **可滾動** - 內容太長可捲動
- ✅ **類似 Richmenu** - 統一體驗

---

**享受所見即所得的視覺化設計！** 🎨✨
