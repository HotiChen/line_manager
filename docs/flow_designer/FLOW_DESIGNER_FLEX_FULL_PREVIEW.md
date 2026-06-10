# 👁️ Flex Message 完整渲染預覽

**更新時間**: 2025-12-14 10:16  
**功能**: 彈出 Modal 顯示完整的 Flex Message

---

## ✅ **新增功能**

### 完整渲染預覽
- ✅ 點擊節點上的「👁️ 完整預覽」按鈕
- ✅ 彈出 Modal 顯示完整渲染的 Flex Message
- ✅ 使用 flex2html 渲染，就像在 LINE 中看到的一樣
- ✅ 支援 Bubble 和 Carousel 類型

---

## 🎨 **視覺效果**

### 節點上的預覽按鈕
```
┌─────────────────────┐
│ 💬 Flex Message     │
├─────────────────────┤
│ ┌─────────────────┐ │
│ │ FAQ 列表        │ │
│ │ 類型: bubble    │ │
│ │ 📷 Hero 圖片    │ │
│ │ 📝 常見問題...  │ │
│ │ 🔘 3 個按鈕     │ │
│ │                 │ │
│ │ [👁️ 完整預覽]   │ │ ← 新按鈕！
│ └─────────────────┘ │
│                 ●   │
└─────────────────────┘
```

### Modal 預覽視窗
```
┌─────────────────────────────┐
│ Flex Message 預覽      [✖️]  │
├─────────────────────────────┤
│ ┏━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ [Hero 圖片]           ┃ │
│ ┃                       ┃ │
│ ┃ 常見問題              ┃ │
│ ┃ 這裡是詳細說明文字... ┃ │
│ ┃                       ┃ │
│ ┃ ┌─────┐ ┌─────┐     ┃ │
│ ┃ │按鈕1│ │按鈕2│     ┃ │
│ ┃ └─────┘ └─────┘     ┃ │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━┛ │
└─────────────────────────────┘
```

---

## 🚀 **使用流程**

### 完整操作步驟
```
1. 新增 Flex Message 節點
2. 載入 Flex Message 資料
3. 節點顯示簡化預覽
4. 點擊「👁️ 完整預覽」按鈕
5. ✨ Modal 彈出！
6. 看到完整渲染的 Flex Message
7. 點擊外部或 ✖️ 關閉
```

---

## 💡 **技術實作**

### flex2html 渲染
```javascript
// 準備 Flex Message 資料
const flexMessage = {
    type: 'flex',
    altText: 'FAQ 列表',
    contents: {
        type: 'bubble',
        hero: { ... },
        body: { ... },
        footer: { ... }
    }
};

// 使用 flex2html 渲染
const html = fml.toHtml(flexMessage);

// 插入到 modal
content.innerHTML = html;

// 顯示 modal
const bsModal = new bootstrap.Modal(modal);
bsModal.show();
```

### Modal 結構
```html
<div class="modal" id="flexPreviewModal">
    <div class="modal-dialog">
        <div class="modal-content">
            <div class="modal-header">
                <h5>Flex Message 預覽</h5>
                <button class="btn-close"></button>
            </div>
            <div class="modal-body" id="flexPreviewContent">
                <!-- Flex Message HTML 渲染在這裡 -->
            </div>
        </div>
    </div>
</div>
```

---

## 🎯 **支援的類型**

### Bubble
- ✅ Hero (圖片/影片)
- ✅ Body (文字、圖片、分隔線等)
- ✅ Footer (按鈕)
- ✅ 完整的樣式和排版

### Carousel
- ✅ 多個 Bubble 卡片
- ✅ 左右滑動（如果 flex2html 支援）
- ✅ 每個卡片的完整內容

---

## 📊 **與簡化預覽的對比**

| 特性 | 簡化預覽 | 完整預覽 |
|------|---------|---------|
| 位置 | 節點上 | Modal 彈窗 |
| 內容 | 摘要資訊 | 完整渲染 |
| 樣式 | 簡單文字 | 實際 Flex 樣式 |
| 互動 | 無 | 可能支援（按鈕等） |
| 用途 | 快速識別 | 詳細檢視 |

---

## 💡 **使用場景**

### 場景 1: 快速識別
```
在節點上看簡化預覽
→ 快速確認是哪個 Flex
→ 不需要打開完整預覽
```

### 場景 2: 詳細檢視
```
想確認 Flex 的完整內容
→ 點擊「完整預覽」
→ 看到實際渲染效果
→ 確認排版和樣式
```

### 場景 3: 展示給他人
```
向同事展示流程
→ 打開完整預覽
→ 展示實際的訊息內容
→ 討論設計細節
```

---

## 🎨 **完整範例**

### 客服 FAQ 流程
```
[ Richmenu: 客服選單 ]
  │
  └─ FAQ ●───→ [ Flex: FAQ 列表 ]
                 │ 簡化預覽:
                 │ - FAQ 列表
                 │ - 類型: bubble
                 │ - 📷 Hero 圖片
                 │ - 📝 常見問題說明
                 │ - 🔘 3 個按鈕
                 │
                 └─ [👁️ 完整預覽] ← 點擊
                    ↓
                 ┌──────────────────┐
                 │ Modal 顯示:      │
                 │ ┏━━━━━━━━━━━━━┓ │
                 │ ┃ [FAQ Banner] ┃ │
                 │ ┃              ┃ │
                 │ ┃ 常見問題     ┃ │
                 │ ┃ 1. 如何...   ┃ │
                 │ ┃ 2. 什麼...   ┃ │
                 │ ┃              ┃ │
                 │ ┃ [更多問題]   ┃ │
                 │ ┃ [聯絡客服]   ┃ │
                 │ ┗━━━━━━━━━━━━━┛ │
                 └──────────────────┘
```

---

## 🚀 **立即體驗**

訪問流程設計器：
```
http://localhost:8787/pages/flow_designer.html
```

### 測試步驟
```
1. 重新載入頁面
2. 新增 Flex Message 節點
3. 選擇並載入一個 Flex Message
4. 看到節點上的簡化預覽
5. 點擊「👁️ 完整預覽」按鈕
6. 🎉 Modal 彈出！
7. 看到完整渲染的 Flex Message！
   - Hero 圖片
   - Body 內容
   - Footer 按鈕
   - 完整的樣式
8. 點擊外部關閉 Modal
9. 繼續設計流程
```

---

## 🔧 **錯誤處理**

### 可能的錯誤
```javascript
// flex2html 未載入
if (typeof fml === 'undefined') {
    toast.error('flex2html 尚未載入');
}

// 資料缺失
if (!node.data.contents) {
    toast.error('無法載入 Flex Message 資料');
}

// 渲染錯誤
try {
    const html = fml.toHtml(flexMessage);
} catch (error) {
    toast.error('Flex Message 渲染失敗');
    // 顯示錯誤訊息
}
```

---

## 💡 **使用技巧**

### 技巧 1: 設計驗證
```
設計 Flex Message
→ 在 Flex Builder 中編輯
→ 載入到 Flow Designer
→ 使用完整預覽確認
→ 確保效果符合預期
```

### 技巧 2: 快速檢查
```
流程中有多個 Flex
→ 簡化預覽快速區分
→ 需要確認時才打開完整預覽
→ 提高工作效率
```

### 技巧 3: 展示模式
```
準備展示流程
→ 打開完整預覽
→ 截圖或投影
→ 清楚展示設計成果
```

---

## 📊 **功能完整度**

✅ **節點預覽** (100%):
- Richmenu: 圖片 + 按鈕
- Flex Message: 摘要 + **完整預覽** ✨
- Text: 文字內容
- 其他: 基本資訊

✅ **渲染系統** (100%):
- flex2html 整合 ✨
- Modal 彈窗 ✨
- 錯誤處理 ✨
- 優雅的 UI ✨

---

## 🎊 **恭喜！**

你現在有**完整的 Flex Message 視覺化系統**：

✨ **簡化預覽** - 節點上快速識別  
✨ **完整渲染** - Modal 詳細檢視  
✨ **flex2html** - 真實的 LINE 樣式  
✨ **一鍵預覽** - 流暢的使用體驗  

試試看點擊「👁️ 完整預覽」按鈕，看看真實的 Flex Message 吧！🎨

---

**享受完整的視覺化體驗！** 👁️✨
