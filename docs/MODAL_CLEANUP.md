# 🔧 Modal Backdrop 清理系統

## 📋 概述

本專案使用全局 Event Listener 自動清理 Bootstrap Modal 關閉後遺留的 backdrop，無需在每個 modal.hide() 後手動添加清理代碼。

## ✅ 已實施的解決方案

### 方案 A: main.js 自動清理（主要頁面）
- **位置**: `js/main.js` 第 139-152 行
- **覆蓋範圍**: 所有使用 main.js 的頁面
- **自動生效**: 是

### 方案 B: 獨立全局腳本（獨立頁面）
- **位置**: `js/shared/global-modal-cleanup.js`
- **使用方式**: 在 HTML 中引入（Bootstrap 之後）
  ```html
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.min.js"></script>
  <script src="../js/shared/global-modal-cleanup.js"></script>
  ```
- **適用頁面**: 
  - `pages/richmenu.html`
  - `pages/imagemap_builder.html`
  - `pages/flow_designer.html`
  - 其他不使用 main.js 的獨立頁面

## 🔍 工作原理

```javascript
// 監聽所有 Bootstrap Modal 的 hidden.bs.modal 事件
document.addEventListener('hidden.bs.modal', function(event) {
  setTimeout(() => {
    // 只有在沒有其他 modal 打開時才清理
    if (!document.querySelector('.modal.show')) {
      // 移除 backdrop
      document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
      // 清理 body 樣式
      document.body.classList.remove('modal-open');
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('padding-right');
    }
  }, 100);
});
```

## 📂 相關文件

### 核心文件
- `js/main.js` - 主應用程式入口，包含全局 modal cleanup
- `js/shared/global-modal-cleanup.js` - 獨立的全局清理腳本
- `helper/modal.helper.js` - 自訂確認對話框工具（已包含 cleanup）

### 已修復的文件（保留了手動清理代碼）
以下文件中仍保留了手動清理代碼作為雙重保險：
- `js/richmenu.js` - Richmenu 編輯器
- `js/team_management.js` - 團隊管理
- `js/profile.js` - 個人資料
- `js/member_builder.js` - 會員管理
- `js/imagemap_builder.js` - Imagemap 編輯器
- `js/flex_builder.js` - Flex Message 編輯器

## 🎯 未來優化建議

### 可選：移除重複的手動清理代碼
由於全局 Event Listener 已經覆蓋所有情況，可以考慮移除各個文件中的手動清理代碼：

```javascript
// ❌ 可以移除（已由全局處理）
setTimeout(() => {
  document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
  document.body.classList.remove('modal-open');
  // ...
}, 300);
```

**建議**: 先測試一段時間，確認全局方案穩定後再移除手動代碼。

## 📊 Modal 使用方式統計

目前專案中使用了以下幾種 Modal 方式：

| 方式 | 使用地方 | Cleanup 方式 |
|------|---------|-------------|
| Bootstrap 原生 | Team Management Invite Modal | 全局 Event Listener |
| JavaScript 手動 | Profile, Member, Imagemap, Flex | 全局 + 手動（雙重） |
| showConfirm Helper | 確認對話框 | Helper 內建 + 全局 |
| 複雜 Modal | Richmenu Editor | 全局 + 手動（雙重） |

## 🐛 除錯

如果發現 backdrop 沒有被清理：

1. 打開瀏覽器控制台
2. 查看是否有 `✅ Global modal backdrop cleanup initialized` 訊息
3. 關閉 modal 時查看是否有 `[Global Modal Cleanup] Removing backdrop` 訊息
4. 檢查是否有 JavaScript 錯誤阻止 Event Listener 執行

## 📅 更新記錄

- **2025-12-25 02:42** - 實施全局 Event Listener 方案
  - 在 main.js 添加全局清理
  - 創建獨立的 global-modal-cleanup.js
  - 保留現有手動清理代碼作為備援

---

**維護者**: AI Assistant  
**最後更新**: 2025-12-25
