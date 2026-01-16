# 更新日誌 (Changelog)

## 2024-12-28 - Quick Reply & 變數替換功能

### 🆕 新增功能

#### 1. 訊息變數替換
在文字訊息中可以使用以下變數，會在發送時自動替換：
- `(@name)` - 使用者 LINE 顯示名稱
- `(@date)` - 今天日期 (例：2024/12/28)
- `(@time)` - 現在時間 (例：14:30)
- `(@day)` - 星期幾 (例：星期六)
- `(@year)` - 年份
- `(@month)` - 月份

#### 2. Quick Reply Keyword 層級支援
- QR 現在附加在**整個關鍵字回覆**，而不是個別回覆
- QR 會自動附加到最後一則訊息
- 向下相容舊的 reply-level QR 資料

#### 3. 前端 UI 改進
- 文字輸入框下方新增**變數快速插入按鈕**
- Keyword Modal 重新排版：回覆內容 → 加入按鈕 → 已加入回覆 → QR 選項
- 關鍵字列表顯示 QR badge 標記
- QR 下拉選單去除重複項目

---

### 📁 修改檔案

#### Frontend
- `pages/keyword_reply_builder.html` - Modal 排版調整
- `js/keyword_reply_builder.js` - QR 改為 keyword-level、QR 去重
- `helper/message.helper.js` - 新增變數插入按鈕

#### Webhook
- `worker_src/lib/event_handler.js` - 新增/更新
  - `getLineUserProfile()` - 取得使用者 Profile
  - `replaceMessageVariables()` - 變數替換
  - `getQuickReplyTemplate()` - 多 KV key 相容
  - `handleMessageEvent()` - keyword-level QR
  - `handleFollowEvent()` - keyword-level QR

---

### ⚠️ 注意事項

1. **舊資料相容**：系統會自動檢查 reply-level 和 keyword-level 的 QR
2. **Webhook 部署**：記得將 `event_handler.js` 部署到 Cloudflare Worker
