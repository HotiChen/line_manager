# 專案備份記錄

## 備份資訊

**備份日期**：2026-01-09 12:00:50  
**備份原因**：會員等級系統開發前的安全備份  

---

## 備份內容

### 📦 備份位置
`/Volumes/Tim 1TB SSD/vs code/new line project/frontend_backup_V2.0_before_tier_system/`

### 📁 包含檔案

#### 前端檔案
- `index.html` - 主頁面
- `css/` - 所有樣式表
- `js/` - 所有 JavaScript 模組
- `pages/` - 所有子頁面
- `helper/` - 輔助函式
- `env/` - 環境配置

#### 後端檔案
- `worker_src/` - Cloudflare Worker 程式碼
  - `index.js` - Worker 入口
  - `handler/` - API 處理器
  - `lib/` - 核心邏輯庫
  - `queue/` - Queue 消費者（已保留，未啟用）
  - `utils/` - 工具函式
  - `migration/` - 資料遷移腳本

#### 配置檔案
- `wrangler.jsonc` - Worker 配置
- `package.json` - 專案依賴
- `DEVELOPMENT_LOG.md` - 開發日誌

---

## 當前系統狀態

### ✅ 正常運作的功能
1. LINE Webhook 整合
2. 關鍵字自動回覆
3. Quick Reply 系統
4. Flex / Imagemap 訊息
5. Rich Menu 管理
6. 分眾 Rich Menu
7. 標籤系統（極簡版）
8. 自動標籤（Keyword & Postback）
9. 訊息推送系統
10. 會員管理

### ⚠️ 已停用的功能（CPU Timeout）
1. recordMemberInteraction - 會員互動記錄
2. ensureTagExists - 標籤預先註冊
3. 反向索引更新 - tag → members 映射
4. syncMemberRichMenu - 自動同步分眾選單

### 🔒 已保留的程式碼（未來升級用）
1. Queue-based 自動標籤系統
2. tag_consumer.js - Queue 消費者
3. 完整版標籤系統邏輯

---

## 部署資訊

**環境**：dev  
**Worker URL**：https://pinti-line-dev.hotichen.workers.dev  
**版本 ID**：befa141c-e8b4-4332-a526-8ab0c1d87868  
**部署時間**：2026-01-09 11:49  
**Cloudflare Workers 方案**：免費版

---

## 資料庫狀態（KV Storage）

### Key Patterns
- `member_profile_{userId}_{lineUserId}` - 會員資料
- `member_list_{userId}` - 會員列表
- `keyword_reply_list_{userId}` - 關鍵字清單
- `tag_list_{userId}` - 標籤清單
- `richmenu_segmented_rules_{userId}` - 分眾選單規則
- `quick_reply_list_{userId}` - Quick Reply 清單
- `flex_message_list_{userId}` - Flex Message 清單
- `imagemap_list_{userId}` - Imagemap 清單
- `access_tokens_{userId}` - LINE Access Tokens
- `destination_user_{destination}` - Webhook 路由

---

## 還原指令

如需還原到此版本：

```bash
# 1. 停止當前服務
cd "/Volumes/Tim 1TB SSD/vs code/new line project/frontend_backup_V1.0"
lsof -ti :8787 | xargs kill -9 2>/dev/null || true

# 2. 還原備份
cd "/Volumes/Tim 1TB SSD/vs code/new line project"
rm -rf frontend_backup_V1.0
cp -r frontend_backup_V2.0_before_tier_system frontend_backup_V1.0

# 3. 重新部署
cd frontend_backup_V1.0
npx wrangler deploy --env dev
```

---

## 下一步開發

### 會員等級系統
- [ ] 等級配置介面
- [ ] 升級規則引擎
- [ ] 權益實作
- [ ] 自動觸發器
- [ ] 測試與驗證

---

**備註**：此備份為穩定版本，所有核心功能經過測試並正常運作。建議在重大變更前先驗證此備份的完整性。
