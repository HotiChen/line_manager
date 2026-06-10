# 🌳 Richmenu 自動展開功能

**更新時間**: 2025-12-14 11:36  
**功能**: 自動為 Richmenu 按鈕創建對應的節點並連接

---

## ✅ **功能說明**

### 自動展開按鈕
載入 Richmenu 後，系統會詢問是否要自動創建對應的節點：

```
此 Richmenu 有 8 個按鈕。
是否自動創建對應的節點並連接？
  [確定]  [取消]
```

---

## 🎯 **支援的按鈕類型**

### 1. URI 按鈕
```
Richmenu → [URI 節點]
  資料：
  - URL
  - 標籤
```

### 2. Message 按鈕
```
Richmenu → [Text 節點]
  資料：
  - 文字內容
  - 標籤
```

### 3. Postback 按鈕
```
Richmenu → [Postback 節點]
  資料：
  - Data
  - 顯示文字
  - 標籤
```

### 4. Richmenuswitch 按鈕
```
Richmenu A → [Richmenu B]
  - 自動載入目標 Richmenu
  - 自動渲染圖片和按鈕
  - 遞迴展開目標 Richmenu 的按鈕
  - 避免循環
```

---

## 🔄 **循環檢測**

### 場景：兩個 Richmenu 互相切換
```
Richmenu A (主選單)
  └─ 按鈕 8: Switch → Richmenu B

Richmenu B (會員頁面)
  └─ 按鈕 8: Switch → Richmenu A
```

### 處理邏輯：
```
1. 載入 Richmenu A
2. 展開按鈕
3. 發現按鈕 8 是 richmenuswitch
4. 創建 Richmenu B 節點
5. 載入 Richmenu B 資料
6. 展開 Richmenu B 的按鈕
7. 發現按鈕 8 指向 Richmenu A
8. ✅ Richmenu A 已存在
9. ✅ 只創建連接，不重複創建節點
10. ✅ 避免無限循環
```

---

## 🎨 **節點排列**

### 垂直排列
```
┌─────────────┐
│  Richmenu   │
│  [圖片]     │
│  8 個按鈕   │●───┐
└─────────────┘    │
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
┌────────┐    ┌────────┐    ┌────────┐
│ URI    │    │ Text   │    │ URI    │
│ 按鈕 1 │    │ 按鈕 2 │    │ 按鈕 3 │
└────────┘    └────────┘    └────────┘
    ●              ●              ●
    
    ▼              ▼              ▼
┌────────┐    ┌────────┐    ┌────────┐
│ URI    │    │ Text   │    │Richmenu│
│ 按鈕 4 │    │ 按鈕 5 │    │ 按鈕 6 │← Switch!
└────────┘    └────────┘   ...展開...
```

### 位置計算
```javascript
baseX = richmenuNode.position.x + 350  // 右側 350px
baseY = richmenuNode.position.y         // 起始 Y
verticalGap = 150                       // 每個節點間距 150px
```

---

## 💡 **使用流程**

### 步驟 1: 創建 Richmenu 節點
```
1. 在畫布上添加 Richmenu 節點
2. 點擊「選擇 Richmenu」
3. 從下拉選單選擇一個 Richmenu
4. 點擊「載入」
```

### 步驟 2: 確認自動展開
```
✅ Richmenu 已載入

彈出確認對話框：
此 Richmenu 有 8 個按鈕。
是否自動創建對應的節點並連接？

[確定] ← 點擊這裡！
```

### 步驟 3: 自動創建節點
```
系統自動：
✅ 分析每個按鈕的動作類型
✅ 創建對應的節點
✅ 自動連接到 Richmenu
✅ 排列在右側，垂直分布
✅ 處理 Richmenuswitch（遞迴展開）
```

---

## 🌳 **完整範例**

### 場景：主選單 + 會員頁面

#### 主選單 (Richmenu A)
```
按鈕 1: URI → https://example.com/promo
按鈕 2: Message → "查看優惠"
按鈕 3: URI → https://example.com/shop
按鈕 4: URI → https://example.com/cart
按鈕 5: Message → "聯絡客服"
按鈕 6: Postback → data: "faq"
按鈕 7: URI → https://example.com/about
按鈕 8: Richmenuswitch → 會員頁面
```

#### 自動生成的流程：
```
                    ┌──────────────┐
                    │ 主選單       │
                    │ [圖片]       │
                    │ 8 個按鈕     │●─────┐
                    └──────────────┘      │
                                          │
    ┌─────────┬─────────┬─────────┬──────┼─────────┬─────────┬─────────┬─────────┐
    │         │         │         │      │         │         │         │         │
    ▼         ▼         ▼         ▼      ▼         ▼         ▼         ▼         
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌──────────────┐
│ URI    ││ Text   ││ URI    ││ URI    ││ Text   ││Postback││ URI    ││ 會員頁面     │
│ Promo  ││查看優惠││ Shop   ││ Cart   ││客服    ││ FAQ    ││ About  ││ [圖片]       │●─┐
└────────┘└────────┘└────────┘└────────┘└────────┘└────────┘└────────┘└──────────────┘ │
                                                                            │            │
                                                                            │            │
                                                                 ┌──────────┴───────┐    │
                                                                 │                  │    │
                                                                 ▼                  ▼    │
                                                            ┌────────┐          ┌────────────┐
                                                            │ URI    │          │ 返回主選單 │
                                                            │會員資料│          │ (Switch)   │◄┘
                                                            └────────┘          └────────────┘
                                                                                     │
                                                                                     └─連回主選單
```

---

## 🔧 **技術實作**

### 核心函數：expandRichmenuButtons
```javascript
async expandRichmenuButtons(richmenuNode, processedRichmenus = new Set()) {
    // 1. 避免重複處理
    processedRichmenus.add(richmenuNode.data.richmenuId);
    
    // 2. 計算位置
    const baseX = richmenuNode.position.x + 350;
    let currentY = richmenuNode.position.y;
    
    // 3. 遍歷每個按鈕
    for (let button of buttons) {
        switch (action.type) {
            case 'uri':
                newNode = this.createNode(NodeTypes.URL, position);
                break;
            case 'message':
                newNode = this.createNode(NodeTypes.MESSAGE_TEXT, position);
                break;
            case 'richmenuswitch':
                // 檢查是否已存在
                if (!已存在) {
                    // 創建新節點
                    // 遞迴展開（如果未處理過）
                }
                break;
        }
        
        // 4. 創建連接
        this.createConnection(richmenuNode.id, newNode.id);
        currentY += 150;
    }
}
```

---

## 💡 **使用技巧**

### 技巧 1: 批量展開
```
一次性建立整個流程：
1. 創建主 Richmenu
2. 點擊「確定」自動展開
3. ✨ 所有按鈕節點自動創建！
4. ✨ 所有連接自動畫好！
5. ✨ 切換的 Richmenu 也自動展開！
```

### 技巧 2: 手動調整
```
自動展開後：
1. 可以手動移動節點位置
2. 可以刪除不需要的節點
3. 可以添加額外的節點
4. 連接會自動跟著移動
```

### 技巧 3: 部分展開
```
如果只想展開部分按鈕：
1. 點擊「取消」
2. 手動創建需要的節點
3. 手動連接
```

---

## 🎊 **優點**

✅ **節省時間**
- 8 個按鈕自動創建 + 連接
- 原本需要手動操作 16 次（創建 + 連接）
- 現在只需 1 次點擊！

✅ **避免錯誤**
- 自動連接，不會忘記
- 循環檢測，避免無限遞迴
- 統一排列，視覺清晰

✅ **完整視覺化**
- 一眼看出所有按鈕的動作
- 清楚了解 Richmenu 之間的切換關係
- 方便檢查和修改流程

---

**享受自動化的便利！** 🌳✨
