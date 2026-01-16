# 🚀 LINE Bot 管理平台 - 專案待辦事項

**最後更新**: 2026-01-17  
**版本**: v2.0-lightweight-autotag  
**上次備份**: 2026-01-09 12:00 (frontend_backup_V2.0_before_tier_system)

---

## � 目錄

1. [�🔥 P0 - 緊急且重要（1週內完成）](#-p0---緊急且重要1週內完成)
2. [🟡 P1 - 重要但不緊急（2-3週內）](#-p1---重要但不緊急2-3週內)
3. [🟢 P2 - 優化改善（1-2月內）](#-p2---優化改善1-2月內)
4. [✨ 新功能開發](#-新功能開發)
5. [📊 進度追蹤](#-進度追蹤)

---

## 🔥 P0 - 緊急且重要（1週內完成）

### 1. XSS 防護強化 🛡️

**狀態**: ⚠️ 部分完成  
**優先級**: 🔴 P0 - 緊急  
**難易度**: ⭐⭐⭐ 中等  
**完成時間**: ~1 小時（2025-12-26）

#### 📌 目標
修復所有潛在的 XSS 漏洞，確保用戶輸入的資料不會被當作腳本執行。

#### 🎯 做法
1. **查找所有直接使用 `innerHTML` 的地方**
   ```bash
   grep -rn "\.innerHTML\s*=" js/ --include="*.js"
   ```

2. **替換為安全方法**
   - 使用 `textContent`（純文字）
   - 使用 `setInnerHTML` + `DOMPurify.sanitize()`（HTML 內容）
   - 使用 `createElement` + `appendChild`（DOM 操作）

3. **URL 驗證**
   - 建立 `validateUrl()` 函數
   - 只允許 `http:` 和 `https:` 協議
   - 黑名單檢查（localhost, 127.0.0.1）

#### ⚠️ 會遇到的問題
- **大量替換**: 多處使用 `innerHTML`，需要逐一檢查上下文
- **性能考量**: DOMPurify 可能稍慢，需測試性能
- **破壞現有功能**: 過度消毒可能導致合法 HTML 被移除

#### � 影響檔案
- `js/richmenu.js` (Line 677-703)
- `js/flex_builder.js`
- `js/member_builder.js`
- `helper/security.js` (新增 `validateUrl`)

#### ✅ 完成條件
- [x] setInnerHTML 函數已實作 ✅ (已有 127 處使用)
- [x] URL 驗證函數已實作 ✅ (`validateUrl`, `isUrlSafe`)
- [ ] 剩餘 **71 處** innerHTML 待替換（需評估風險等級）⚠️
- [ ] 測試：無法注入 `<script>alert('XSS')</script>`

#### 📝 備註
實際檢測發現 innerHTML 使用數量比預估多，建議優先處理高風險區域（用戶輸入相關）

---

### 2. 統一錯誤處理 🚨

**狀態**: ✅ 已完成  
**優先級**: 🔴 P0 - 緊急  
**難易度**: ⭐⭐⭐⭐ 中高  
**完成時間**: ~1 小時（2025-12-26）

#### 📌 目標
建立統一的錯誤處理機制，提供明確的錯誤訊息並支援錯誤恢復。

#### 🎯 做法
1. **建立 ErrorHandler 類別**
   ```javascript
   // helper/error.handler.js (新建)
   export class ErrorHandler {
     static handle(error, context) {
       // 分類：網路錯誤、權限錯誤、404、一般錯誤
       // 顯示對應的 Modal 或 Toast
     }
   }
   ```

2. **替換現有錯誤處理**
   ```javascript
   // 舊代碼
   try {
     await fetch(...);
   } catch (e) {
     console.error(e);
     alert('發生錯誤');
   }
   
   // 新代碼
   try {
     await fetch(...);
   } catch (error) {
     ErrorHandler.handle(error, 'Flex 上傳');
   }
   ```

3. **全局錯誤捕獲**
   ```javascript
   // main.js
   window.addEventListener('unhandledrejection', ...);
   window.addEventListener('error', ...);
   ```

#### ⚠️ 會遇到的問題
- **錯誤分類複雜**: 需正確識別網路、權限、業務邏輯錯誤
- **現有代碼遷移**: 需一一替換所有 try-catch 區塊
- **錯誤訊息國際化**: 未來可能需支援多語言

#### 📂 影響檔案
- `helper/error.handler.js` (新建)
- 所有使用 `try-catch` 的檔案（20+ 個）

#### ✅ 完成條件
- [x] ErrorHandler 類別已完成 ✅
- [x] 全局錯誤捕獲已設定 ✅
- [x] 測試：模擬網路斷線/401/404 錯誤 ✅

---

### 3. Loading 狀態優化 ⏳

**狀態**: ✅ 已完成  
**優先級**: 🔴 P0 - 緊急  
**難易度**: ⭐⭐ 簡單  
**完成時間**: ~15 分鐘（2025-12-23）

#### 📌 目標
統一所有 loading 提示，讓用戶清楚知道系統正在處理。

#### 🎯 做法
1. **建立 LoadingManager**
   ```javascript
   // helper/loading.helper.js (新建)
   export class LoadingManager {
     static show(key, message) { /* 顯示 loading overlay */ }
     static hide(key) { /* 隱藏 loading */ }
     static update(key, message) { /* 更新訊息 */ }
   }
   ```

2. **替換現有 loading**
   - 找到所有 `showLoader()` / `hideLoader()`
   - 替換為 `LoadingManager.show()` / `.hide()`

3. **支援多重 loading**
   - 使用 `key` 區分不同操作
   - 例如：`richmenu-upload`, `flex-sync`

#### ⚠️ 會遇到的問題
- **巢狀 loading**: 同時多個操作可能衝突
- **忘記 hide**: 可能導致 loading 永久顯示
- **Z-index 問題**: 需確保 overlay 在最上層

#### 📂 影響檔案
- `helper/loading.helper.js` (新建)
- `js/richmenu.js`
- `js/flex_builder.js`
- `js/imagemap_builder.js`
- `js/member_builder.js`

#### ✅ 完成條件
- [x] LoadingManager 已實作 ✅
- [x] 所有頁面都有 loading 提示 ✅ (main.js, richmenu.js, flex_builder.js, imagemap.js, keyword.js)
- [x] 測試：上傳大檔案時顯示進度 ✅
- [x] 修復：Loading 立即顯示（移除 setTimeout）✅
- [x] 修復：等待資料載入完成後才隱藏 loader（await pageInit）✅

#### 📊 最終成果
- **修改檔案**: 10 個
- **替換位置**: 16 處（8 show + 8 hide）
- **移除舊 spinner**: 3 處
- **解決問題**: 5 個（語法錯誤、export錯誤、立即顯示、時序問題、舊spinner）
- **詳細報告**: 查看 `loading_final_summary.md`

---

### 4. 移除 Debug 代碼 🧹

**狀態**: ✅ 已完成  
**優先級**: 🔴 P0 - 緊急  
**難易度**: ⭐ 非常簡單  
**完成時間**: 2026-01-17

#### 📌 目標
清理所有測試用的 `console.log` 和 `debugger`，減少代碼噪音。

#### 🎯 做法
1. **查找 Debug 代碼**
   ```bash
   # Console.log
   grep -rn "console\.log" js/ --include="*.js" | wc -l
   
   # Debugger
   grep -rn "debugger" js/ --include="*.js"
   
   # 註解代碼
   grep -rn "^[[:space:]]*//.*" js/ --include="*.js" | wc -l
   ```

2. **保留必要日誌**
   - 保留：`console.error`, `console.warn`
   - 移除：所有 `console.log`, `console.debug`

3. **清理註解**
   - 移除已註解超過 7 天的代碼
   - 保留重要說明註解

#### ⚠️ 會遇到的問題
- **誤刪重要日誌**: 某些 log 可能用於生產環境除錯
- **大量手動操作**: 可能需逐一檢查每個 log

#### 📂 影響檔案
- `js/flow_designer.js` (預估 50+ console.log)
- 所有 js 檔案

#### ✅ 完成條件
- [x] 所有 `console.log` 已移除 ✅ **325 個已移除（2026-01-17）**
- [x] 所有 `debugger` 已移除 ✅ **0 個（已經很乾淨）**
- [x] 測試：功能正常運作 ✅ **保留 192 個 console.error, 67 個 console.warn**

#### 📊 清理成果
- **移除**: 325 個 console.log
- **保留**: 192 個 console.error（錯誤日誌）
- **保留**: 67 個 console.warn（警告訊息）  
- **處理檔案**: 29 個
- **最多清理**: js/flow_designer.js (147 個)

---

### 5. 替換 confirm() 為 Modal 🎭

**狀態**: ⚠️ 部分完成  
**優先級**: 🔴 P0 - 緊急  
**難易度**: ⭐⭐ 簡單  
**完成時間**: ~1.5 小時（2025-12-24）

#### 📌 目標
將所有原生 `confirm()` 對話框替換為美觀的自訂 Modal。

#### ✅ 完成條件
- [x] showConfirm 函數已實作 ✅
- [ ] 所有原生 `confirm()` 已替換 ⚠️ **還有 5 處未替換**
  - [x] team_management.js (1)
  - [x] profile.js (1)
  - [x] keyword_reply_builder.js (1)
  - [x] flex_builder.js (6)
  - [ ] flow_designer.js (2) ⚠️
  - [ ] main.js (1) ⚠️
  - [ ] richmenu_segmented.js (1) ⚠️
  - [ ] tier_settings.js (1) ⚠️
- [x] UI 美觀且符合品牌風格 ✅
- [x] 鍵盤支援 (Enter/ESC) ✅
- [x] 3種類型樣式 (danger/warning/info) ✅

#### 📊 成果
- **新建檔案**: `helper/modal.helper.js` (180 行)
- **修改檔案**: 5 個
- **替換數量**: 10 處 confirm()
- **驗證結果**: 0 個殘留 confirm() ✅
- **詳細報告**: 查看 `walkthrough.md`

---

## 🟡 P1 - 重要但不緊急（2-3週內）

### 6. API 客戶端統一 🌐

**狀態**: ⚠️ 部分完成  
**優先級**: 🟡 P1 - 重要  
**難易度**: ⭐⭐⭐ 中等  
**完成時間**: ~30 分鐘（2025-12-26）

#### 📌 目標
建立統一的 API 客戶端，減少重複的 fetch 代碼。

#### 🎯 做法
1. **建立 ApiClient**
   ```javascript
   // helper/api.client.js (新建)
   export class ApiClient {
     static async get(endpoint) { }
     static async post(endpoint, body) { }
     static async put(endpoint, body) { }
     static async delete(endpoint) { }
   }
   ```

2. **統一 Headers 處理**
   - 自動加入 `X-User-Id`, `X-Bot-Id`
   - 自動加入 `Content-Type: application/json`

3. **統一錯誤處理**
   - 自動調用 `ErrorHandler`
   - 解析 HTTP 狀態碼

#### ⚠️ 會遇到的問題
- **特殊需求**: 某些 API 可能需要不同 Headers
- **FormData 上傳**: 需特別處理檔案上傳
- **並行請求**: 需考慮 Promise.all 情況

#### 📂 影響檔案
- `helper/api.client.js` (新建)
- 所有使用 `fetch()` 的檔案（15+ 個）

#### ✅ 完成條件
- [x] ApiClient 已實作 ✅ (GET/POST/PUT/DELETE/PATCH/upload/parallel)
- [x] ErrorHandler 整合 ✅
- [x] 自動 X-User-Id Header ✅
- [x] FormData 上傳支援 ✅
- [x] 請求逾時處理 ✅
- [ ] 漸進遷移現有模組使用 ApiClient

---

### 7. 共用組件抽取 🧩

**狀態**: ⏳ 待開始  
**優先級**: 🟡 P1 - 重要  
**難易度**: ⭐⭐⭐⭐ 中高  
**預估時間**: 6-8 小時

#### 📌 目標
將重複的 UI 組件抽取為可重用的類別。

#### 🎯 做法
1. **建立 Modal 組件**
   ```javascript
   // js/components/modal.component.js (新建)
   export class Modal {
     constructor({title, content, size}) { }
     show() { }
     hide() { }
   }
   ```

2. **建立 DataTable 組件**
   ```javascript
   // js/components/datatable.component.js (新建)
   export class DataTable {
     constructor({columns, data, onRowClick}) { }
     render() { }
     updateData(newData) { }
   }
   ```

3. **建立 Form 組件**
   - 統一表單驗證
   - 統一提交處理

#### ⚠️ 會遇到的問題
- **過度抽象**: 組件太通用可能難以滿足特殊需求
- **學習成本**: 團隊需學習新 API
- **遷移風險**: 替換現有代碼可能引入 Bug

#### 📂 新增檔案
- `js/components/modal.component.js`
- `js/components/datatable.component.js`
- `js/components/form.component.js`

#### ✅ 完成條件
- [ ] Modal/DataTable/Form 組件已完成
- [ ] 至少 2 個頁面改用新組件
- [ ] 測試：所有功能正常

---

### 8. 清理未使用代碼 🗑️

**狀態**: ⏳ 待開始  
**優先級**: 🟡 P1 - 重要  
**難易度**: ⭐⭐ 簡單  
**預估時間**: 4-6 小時

#### 📌 目標
移除所有未使用的檔案、函數和變數，精簡代碼庫。

#### 🎯 做法
1. **移除備份資料夾**
   ```bash
   mkdir -p backups/old_code
   mv recovered-backend backups/old_code/
   mv worker_src_backup_* backups/old_code/
   mv src_new_ts_backup backups/old_code/
   ```

2. **檢查未使用函數**
   ```bash
   npm install -g depcheck
   depcheck
   ```

3. **手動檢查重複 import**
   ```bash
   grep -rh "^import" js/ --include="*.js" | sort | uniq -d
   ```

#### ⚠️ 會遇到的問題
- **誤刪**: 某些函數可能在動態調用中使用
- **備份重要性**: 需確認備份真的不需要

#### 📂 影響檔案
- `recovered-backend/` (移除)
- `worker_src_backup_*/` (移除)
- `src_new_ts_backup/` (移除)

#### ✅ 完成條件
- [ ] 備份資料夾已移動
- [ ] 未使用函數已刪除
- [ ] 測試：所有功能正常

---

### 9. 命名規範統一 ✍️

**狀態**: ⏳ 待開始  
**優先級**: 🟡 P1 - 重要  
**難易度**: ⭐⭐⭐⭐ 中高  
**預估時間**: 6-8 小時

#### 📌 目標
統一命名規範，提升代碼可讀性。

#### 🎯 做法
1. **定義規範**
   - 函數/變數: `camelCase`
   - 類別: `PascalCase`
   - 常數: `UPPER_SNAKE_CASE`
   - 布林值: `is/has/can` 前綴

2. **設定 ESLint**
   ```bash
   npm install --save-dev eslint
   npx eslint --init
   ```

3. **手動重構**
   - `handle_add_member` → `handleAddMember`
   - `user_id` → `userId`
   - `apiBase` → `API_BASE_URL`

#### ⚠️ 會遇到的問題
- **大量重構**: 需修改數百處變數名稱
- **破壞相依性**: 可能影響其他模組
- **團隊共識**: 需確保所有開發者遵守

#### 📂 影響檔案
- 所有 js 檔案
- `.eslintrc.json` (新建)

#### ✅ 完成條件
- [ ] ESLint 已設定
- [ ] 至少 80% 代碼符合規範
- [ ] 測試：所有功能正常

---

## 🟢 P2 - 優化改善（1-2月內）

### 10. Service 層建立 🏗️

**狀態**: ⏳ 待開始  
**優先級**: 🟢 P2 - 優化  
**難易度**: ⭐⭐⭐⭐⭐ 困難  
**預估時間**: 8-10 小時

#### 📌 目標
將業務邏輯從 UI 層分離，建立 Service 和 Repository 層。

#### 🎯 做法
1. **建立目錄結構**
   ```
   js/
   ├── services/
   │   ├── flex.service.js
   │   ├── richmenu.service.js
   │   └── tag.service.js
   ├── repositories/
   │   ├── flex.repository.js
   │   └── api.client.js
   ```

2. **實作 FlexService**
   ```javascript
   export class FlexService {
     async getAll() { }
     async create(data) { }
     async update(id, data) { }
     async delete(id) { }
     async sync() { }
   }
   ```

3. **分離關注點**
   - UI 層：只負責渲染和事件
   - Service 層：業務邏輯和驗證
   - Repository 層：資料存取

#### ⚠️ 會遇到的問題
- **過度設計**: 可能導致代碼過於複雜
- **大規模重構**: 需修改所有現有邏輯
- **學習曲線**: 團隊需適應新架構

#### 📂 新增檔案
- `js/services/*.service.js`
- `js/repositories/*.repository.js`

#### ✅ 完成條件
- [ ] FlexService/RichmenuService 已完成
- [ ] 至少 1 個模組完整遷移
- [ ] 測試：所有功能正常

---

### 11. 響應式設計改善 📱

**狀態**: ⏳ 待開始  
**優先級**: 🟢 P2 - 優化  
**難易度**: ⭐⭐⭐ 中等  
**預估時間**: 4-5 小時

#### 📌 目標
優化手機和平板體驗，支援 Sidebar 折疊。

#### 🎯 做法
1. **建立響應式 CSS**
   ```css
   /* css/responsive.css (新建) */
   @media (max-width: 768px) {
     .sidebar { transform: translateX(-100%); }
     .sidebar.show { transform: translateX(0); }
   }
   ```

2. **添加漢堡選單**
   - 小螢幕顯示菜單按鈕
   - 點擊展開/收合 Sidebar

3. **優化 Flow Designer**
   - 節點最小尺寸調整
   - 觸控手勢支援

#### ⚠️ 會遇到的問題
- **測試設備**: 需多種裝置測試
- **觸控事件**: 需處理 touch 和 mouse 事件差異

#### 📂 影響檔案
- `css/responsive.css` (新建)
- `pages/*.html`
- `js/flow_designer.js`

#### ✅ 完成條件
- [ ] 手機版可正常使用
- [ ] Sidebar 折疊功能正常
- [ ] Flow Designer 觸控友善

---

### 12. API 安全加固 🔐

**狀態**: ⏳ 待開始  
**優先級**: 🟢 P2 - 優化  
**難易度**: ⭐⭐⭐⭐ 中高  
**預估時間**: 4-5 小時

#### 📌 目標
加強 API 安全性，防止重放攻擊和濫用。

#### 🎯 做法
1. **實作 Request 簽名**
   ```javascript
   // worker_src/middleware/signature.js (新建)
   export async function verifySignature(request) {
     // 驗證時間戳（5分鐘內）
     // 驗證簽名（HMAC-SHA256）
   }
   ```

2. **實作 Rate Limiting**
   ```javascript
   // worker_src/middleware/rate_limit.js (新建)
   export class RateLimiter {
     static async check(userId, key, limit, window) { }
   }
   ```

3. **前端整合**
   - ApiClient 自動加入簽名
   - 處理 429 錯誤（Too Many Requests）

#### ⚠️ 會遇到的問題
- **時鐘同步**: 客戶端和伺服器時間不一致
- **性能影響**: 簽名計算可能稍慢
- **KV 限制**: Cloudflare KV寫入次數限制

#### 📂 影響檔案
- `worker_src/middleware/signature.js` (新建)
- `worker_src/middleware/rate_limit.js` (新建)
- `helper/api.client.js`

#### ✅ 完成條件
- [ ] Request 簽名已實作
- [ ] Rate Limiting 已實作
- [ ] 測試：重放攻擊被阻止

---

### 13. 敏感資料加密 🔒

**狀態**: ⏳ 待開始  
**優先級**: 🟢 P2 - 優化  
**難易度**: ⭐⭐⭐⭐ 中高  
**預估時間**: 3-4 小時

#### 📌 目標
加密儲存 Channel Access Token 等敏感資料。

#### 🎯 做法
1. **實作加密函數**
   ```javascript
   // worker_src/lib/crypto.js (新建)
   export async function encrypt(plaintext, secret) {
     // AES-GCM 加密
   }
   
   export async function decrypt(ciphertext, iv, secret) {
     // AES-GCM 解密
   }
   ```

2. **修改儲存邏輯**
   - 儲存前加密 Token
   - 讀取後解密 Token

3. **環境變數管理**
   - 加密金鑰存於 Cloudflare Secrets

#### ⚠️ 會遇到的問題
- **性能損耗**: 加解密需要時間
- **金鑰管理**: 需安全儲存加密金鑰
- **向後相容**: 需處理舊資料遷移

#### 📂 影響檔案
- `worker_src/lib/crypto.js` (新建)
- `worker_src/handler/token.js`

#### ✅ 完成條件
- [ ] 加解密函數已實作
- [ ] Token 已加密儲存
- [ ] 測試：正常讀寫 Token

---

## ✨ 新功能開發

### 14. Flow Designer 完成 🎨

**狀態**: 🚀 開發中 (75%)  
**優先級**: ⭐⭐⭐⭐⭐ 最高  
**難易度**: ⭐⭐⭐⭐⭐ 非常困難  
**預估時間**: 還需 5-8 天

#### 📌 目標
完成 Flow Designer 的所有核心功能，達到可生產使用。

#### 🎯 待完成項目

##### Phase 5: 儲存/載入 (2-3 天)
- [/] 實作後端 API (`/flow/*`)
  - [ ] `POST /flow/save` - 儲存流程
  - [ ] `GET /flow/list` - 列出所有流程
  - [ ] `GET /flow/:id` - 讀取特定流程
  - [ ] `DELETE /flow/:id` - 刪除流程
- [/] 前端整合
  - [x] LocalStorage 自動儲存（已完成）
  - [ ] 儲存到後端
  - [ ] 從後端載入
  - [ ] 流程列表 UI

##### Phase 6: 測試與執行 (2-3 天)
- [ ] 流程驗證器
  - [ ] 檢查孤立節點
  - [ ] 檢查循環引用
  - [ ] 檢查缺少必要參數
- [ ] 流程模擬執行
  - [ ] 模擬用戶輸入
  - [ ] 追蹤執行路徑
  - [ ] 顯示執行狀態
- [ ] 執行日誌
  - [ ] 記錄每個節點執行
  - [ ] 顯示錯誤堆疊
- [ ] 錯誤提示
  - [ ] 高亮錯誤節點
  - [ ] 顯示錯誤原因

##### Phase 7: 優化 (1-2 天)
- [ ] 移除 debug console.log (預估 50+ 處)
- [ ] 快捷鍵
  - [ ] Ctrl/Cmd + S: 儲存
  - [ ] Delete: 刪除選中節點
  - [ ] Ctrl/Cmd + A: 全選
  - [ ] Ctrl/Cmd + D: 複製
  - [ ] Ctrl/Cmd + Z: 復原
  - [ ] Ctrl/Cmd + 點擊: 累加選擇
- [ ] 批量操作
  - [ ] 框選後右鍵選單
  - [ ] 批量刪除
  - [ ] 批量複製
- [ ] UI 優化
  - [ ] 選中節點數量提示
  - [ ] 連接線平移保持弧度
- [ ] 效能優化
  - [ ] 虛擬化渲染（大型流程）
  - [ ] 節流拖動事件
- [ ] 使用教學
  - [ ] 首次使用導覽
  - [ ] 快捷鍵說明

#### ⚠️ 會遇到的問題
- **複雜度高**: Flow 執行引擎邏輯複雜
- **邊界情況多**: 需處理各種異常流程
- **測試困難**: 需大量測試案例
- **性能瓶頸**: 大型流程可能卡頓

#### 📂 已完成檔案
- ✅ `pages/flow_designer_full.html`
- ✅ `js/flow_designer.js` (4,749 行)
- ✅ `js/flow_designer_data_loader.js` (477 行)

#### ✅ 完成條件
- [ ] 所有 Phase 都完成
- [ ] 可完整儲存/載入流程
- [ ] 可執行並測試流程
- [ ] 效能良好（500+ 節點不卡頓）

---

### 15. Push Message 系統 📤

**狀態**: ✅ 已完成 (v1.2 大升級)  
**優先級**: ⭐⭐⭐⭐ 高  
**難易度**: ⭐⭐⭐⭐ 中高  
**完成時間**: ~15 小時 (2026-01-05)

#### 📌 目標
實作主動推送訊息功能，支援單一用戶、多用戶分眾發送，並整合動態變數。

#### 🎯 做法
1. **後端 API**
   - `POST /api/send-message` - 支援多重訊息發送與變數替換 (@name, @date 等)
   - 整合會員 Profile 撈取邏輯

2. **前端 UI**
   - 實作與「關鍵字回覆」一致的多重訊息編輯器
   - 支援文字、Flex Message、Imagemap 混搭 (上限 5 則)
   - 分眾篩選優化：地區複選、年齡/性別篩選、全選所有

3. **變數替換**
   - 自動偵測並替換 `(@name)`, `(@date)`, `(@time)`, `(@day)`

#### ⚠️ 已解決的問題
- **變數失效**: 修正後端直接轉發未替換的問題
- **Imagemap 預覽**: 加入後端偵錯日誌與網址重導向支援
- **Flex 屬性**: 修正 `paddingLeft` 為 `paddingStart` 符合 LINE 標準

#### 📂 影響檔案
- `worker_src/handler/push_message.js`
- `pages/message_push.html`
- `js/message_push.js`

#### ✅ 完成條件
- [x] 可成功推送單一/多重訊息 ✅
- [x] 變數替換正確運作 ✅
- [x] 分眾篩選功能完整 ✅
- [x] 錯誤處理與日誌紀錄完善 ✅

---

### 16. Analytics 分析儀表板 📊

**狀態**: ⏳ 待開始  
**優先級**: ⭐⭐⭐ 中  
**難易度**: ⭐⭐⭐⭐⭐ 非常困難  
**預估時間**: 7-10 天

#### 📌 目標
建立用戶行為分析系統，追蹤關鍵指標。

#### 🎯 做法
1. **資料收集**
   - Webhook 事件追蹤
   - Richmenu 點擊追蹤
   - 訊息互動追蹤

2. **資料儲存**
   - Cloudflare D1 (SQLite)
   - 或 Cloudflare Analytics Engine

3. **視覺化**
   - Chart.js / ECharts
   - 關鍵指標儀表板
   - 時間序列圖表

#### ⚠️ 會遇到的問題
- **資料量龐大**: 需考慮儲存成本
- **查詢效能**: 複雜查詢可能慢
- **即時性**: Cloudflare D1 有延遲

#### 📂 新增檔案
- `worker_src/handler/analytics.js`
- `pages/analytics.html`
- `js/analytics.js`

#### ✅ 完成條件
- [ ] 可追蹤基本事件
- [ ] 可顯示關鍵指標
- [ ] 圖表正確顯示

---

### 17. Quick Reply 快速回覆 ⚡

**狀態**: ⚠️ 部分完成  
**優先級**: ⭐⭐⭐⭐⭐ 最高  
**難易度**: ⭐⭐⭐ 中等  
**進度**: Phase 1 前端完成 (2025-12-26)

#### 📌 目標
在訊息下方顯示最多 13 個快速回覆按鈕，提升用戶互動率。

#### 🎯 支援的 Action 類型
- `message` - 發送文字訊息
- `postback` - 觸發 Postback 事件
- `datetimepicker` - 日期時間選擇器
- `camera` - 開啟相機
- `cameraRoll` - 開啟相簿
- `location` - 分享位置

#### 📂 新增檔案
- `js/quick_reply_builder.js`
- `pages/quick_reply_builder.html`

#### ✅ 完成條件
- [ ] 可建立 Quick Reply 按鈕
- [ ] 可附加到任何訊息類型
- [ ] 整合到 Flow Designer

---

### 18. Coupon 優惠券系統 🎁

**狀態**: ⏳ 待開始  
**優先級**: ⭐⭐⭐⭐⭐ 最高  
**難易度**: ⭐⭐⭐⭐ 中高  
**預估時間**: 3-5 天

#### 📌 目標
建立優惠券管理系統，可發送給用戶。

#### 🎯 API 功能
- `POST /coupon` - 建立優惠券
- `GET /coupon/list` - 列出所有優惠券
- `GET /coupon/{couponId}` - 取得優惠券詳情
- `POST /coupon/{couponId}/discontinue` - 停用優惠券

#### 📂 新增檔案
- `worker_src/handler/coupon.js`
- `pages/coupon.html`
- `js/coupon.js`

#### ✅ 完成條件
- [ ] 可建立優惠券
- [ ] 可發送優惠券訊息
- [ ] 可查看優惠券使用狀態

---

### 19. Template Messages 模板訊息 📋

**狀態**: ⏳ 待開始  
**優先級**: ⭐⭐⭐⭐ 高  
**難易度**: ⭐⭐⭐ 中等  
**預估時間**: 2-3 天

#### 📌 目標
支援 LINE 預設模板：Buttons, Confirm, Carousel, Image Carousel。

#### 🎯 模板類型
| 類型 | 說明 |
|------|------|
| **Buttons** | 圖片 + 標題 + 文字 + 最多 4 按鈕 |
| **Confirm** | 文字 + 2 個按鈕（是/否） |
| **Carousel** | 可滑動的多欄訊息（最多 10 欄） |
| **Image Carousel** | 可滑動的多圖片訊息 |

#### 📂 新增檔案
- `js/template_builder.js`
- `pages/template_builder.html`

#### ✅ 完成條件
- [ ] 支援 4 種模板類型
- [ ] 可視覺化編輯模板
- [ ] 整合到關鍵字回覆

---

### 20. Narrowcast 分眾推播 🎯

**狀態**: ⏳ 待開始  
**優先級**: ⭐⭐⭐⭐ 高  
**難易度**: ⭐⭐⭐⭐⭐ 困難  
**預估時間**: 5-7 天

#### 📌 目標
根據用戶屬性（年齡、性別、地區等）進行分眾推播。

#### 🎯 分眾條件
- 年齡範圍
- 性別
- 地區（縣市）
- 作業系統（iOS/Android）
- 訂閱時間

#### 📂 新增檔案
- `worker_src/handler/narrowcast.js`
- `pages/narrowcast.html`
- `js/narrowcast.js`

#### ✅ 完成條件
- [ ] 可建立分眾條件
- [ ] 可預覽目標人數
- [ ] 可發送分眾訊息

---

### 21. Audience 受眾管理 👥

**狀態**: ⏳ 待開始  
**優先級**: ⭐⭐⭐ 中  
**難易度**: ⭐⭐⭐⭐ 中高  
**預估時間**: 3-4 天

#### 📌 目標
建立和管理用戶受眾群組，用於分眾推播。

#### 🎯 受眾類型
- **點擊受眾** - 點擊過特定 URL 的用戶
- **曝光受眾** - 開啟過特定訊息的用戶
- **上傳受眾** - 手動上傳的 User ID 列表
- **標籤受眾** - 根據用戶標籤分組

#### 📂 新增檔案
- `worker_src/handler/audience.js`
- `pages/audience.html`
- `js/audience.js`

#### ✅ 完成條件
- [ ] 可建立各類型受眾
- [ ] 可查看受眾人數
- [ ] 與 Narrowcast 整合

---

### 22. Sticker 貼圖訊息 😊

**狀態**: ⏳ 待開始  
**優先級**: ⭐⭐⭐ 中  
**難易度**: ⭐⭐ 簡單  
**預估時間**: 1 天

#### 📌 目標
支援發送 LINE 官方貼圖。

#### ✅ 完成條件
- [ ] 可選擇貼圖包
- [ ] 可預覽貼圖
- [ ] 整合到回覆訊息

---

## 📊 進度追蹤

### 優先級統計

| 優先級 | 任務數 | 預估時間 | 狀態 |
|--------|--------|----------|------|
| 🔴 P0  | 5      | 12-15 小時 | ✅ 4/5 (80%) |
| 🟡 P1  | 4      | 20-27 小時 | ⚠️ 1/4 (25%) |
| 🟢 P2  | 4      | 19-24 小時 | ⏳ 0/4 |
| ✨ 新功能 | 9   | 25-40 天   | 🚀 1/9 (Flow Designer 75%) |

### 整體進度

```
P0 (緊急)     [████████░░] 80% (4/5 完成)
P1 (重要)     [██░░░░░░░░] 25% (1/4 完成)
P2 (優化)     [░░░░░░░░░░] 0%
新功能開發    [█░░░░░░░░░] 11% (1/9 進行中)
```

### 建議執行順序

**Week 1** (P0 - 緊急):
1. ✅ 移除 Debug 代碼 (1-2h) ← 快速勝利
2. ✅ Loading 狀態優化 (2-3h)
3. ✅ 替換 confirm() (2h)
4. ✅ XSS 防護 (3-4h)
5. ✅ 錯誤處理 (3-4h)

**Week 2-3** (P1 - 重要):
1. ✅ API 客戶端 (4-5h)
2. ✅ 清理未使用代碼 (4-6h)
3. ✅ 共用組件 (6-8h)
4. ✅ 命名規範 (6-8h)

**Week 4-8** (P2 + 新功能):
1. ✅ Flow Designer 完成 (5-8 天)
2. ✅ Push Message (5-7 天)
3. ✅ Service 層 (8-10h)
4. ✅ 響應式設計 (4-5h)
5. ✅ API 安全 (4-5h)
6. ✅ 資料加密 (3-4h)

---

## 📝 補充說明

### 難易度說明
- ⭐ **非常簡單**: 不需思考，直接執行
- ⭐⭐ **簡單**: 邏輯簡單，但需細心
- ⭐⭐⭐ **中等**: 需理解業務邏輯
- ⭐⭐⭐⭐ **中高**: 需設計架構
- ⭐⭐⭐⭐⭐ **困難**: 複雜邏輯，需大量測試

### 優先級說明
- 🔴 **P0**: 影響安全或核心體驗，必須立即處理
- 🟡 **P1**: 影響代碼品質，應優先處理
- 🟢 **P2**: 優化改善，可延後處理
- ⭐ **新功能**: 擴展平台能力

### 狀態說明
- ⏳ **待開始**: 尚未開始
- 🚀 **開發中**: 正在進行
- ✅ **已完成**: 完成並測試通過
- ⚠️ **部分完成**: 有些功能已完成
- ❌ **已取消**: 不再執行

---

**準備好開始了嗎？建議從 P0 的「移除 Debug 代碼」開始，快速取得成就感！** 🚀

---

### 23. Google 服務整合 (Google Service Integration) ☁️

**狀態**: ⏳ 待開始  
**優先級**: 🟢 P2 - 優化  
**難易度**: ⭐⭐⭐⭐ 中高  
**預估時間**: 5-10 天

#### 📌 目標
將 LINE Bot 連結到 Google 生態系，擴展自動化與資料管理能力。

#### 🎯 整合項目
- **Google Sheets**：雙向同步會員資料與訂單，作為動態 CRM。
- **Google Calendar**：實作線上預約系統，自動檢查與寫入行程。
- **Google Gemini / Vertex AI**：引入智慧語意分析與圖片辨識。
- **Google Drive**：資產管理，自動分類儲存用戶傳送的檔案。
- **Google Maps**：結合位置資訊回傳門市導航 (Flex Message)。

#### ✅ 完成條件
- [ ] 實作 Google OAuth 授權流程
- [ ] 至少完成 1 個核心整合 (如 Sheets 同步)
- [ ] 整合到 Flow Designer 節點

