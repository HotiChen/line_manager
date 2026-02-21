---
description: 三方驗收與自動化部署 - 將開發完成的程式碼經過 Code Review、測試、資安掃描後，無縫推上正式環境的流程
---

# 🛡️ 鐵血驗收與上線流水線 (QA & Deploy Flow)

程式碼寫完會動，不代表它可以上線！
這條工作流 (`/qa-deploy`) 是專案進入 Production (正式環境) 前的**最後防線 (The Final Gatekeeper)**。它會依序啟動四位最嚴格的把關者，只要有任何一位專家打回票，部署流程就會強制中斷，直到開發者將 Bug 修復為止。

## 🎯 運作流程與聯合會診順序

當 `/build-feature` 開發完畢，您決定將某幾支檔案或整個功能模組推上線時，請喚醒此流水線：

1. **👨‍⚖️ `/code-reviewer` (資深程式碼審查員) 執行 Peer Review**
   - **檢查重點**: 檢查是否符合 `/code-audit` 列出的命名規範 (Camel-case 等)。
   - **攔截條件**: 若發現有硬寫死 (Hardcode) 的 Magic Numbers，或是沒有寫 JSDoc / Pre-conditions，直接 Reject。
   - **產出**: `docs/review_report.md` (列出必須修改的行號與建議寫法)。

2. **🧪 `/test-engineer` (自動化測試開發 SDET) 邊界條件轟炸**
   - **檢查重點**: 針對剛才審查通過的核心 Function，撰寫 Edge Cases 單元測試 (傳入 null, undefined, 超大數值)。
   - **攔截條件**: 無法通過 Assert 驗證，或是覆蓋率 (Coverage) 明顯不足。
   - **產出**: 更新專案的 `.test.js` 或 `.spec.js` 檔案，確保防護網建立完畢。

3. **🛡️ `/security-auditor` (資安查核員) 惡意滲透測試**
   - **檢查重點**: 以駭客視角掃描剛寫好的 Code。最重要的是檢查**越權存取漏洞 (IDOR/BOLA)** 與**金流狀態機是否能被繞過**。檢查前端 HTML 看看有沒有防止 XSS Injection 的防護。
   - **攔截條件**: 只要發現有任何可以直接修改別人資料，或是偽造付款成功的破綻，立刻發出 [CRITICAL] 警告並終止部署。
   - **產出**: `docs/security_audit.md` (若無漏洞則為 PASS)。

4. **🌩️ `/devops-engineer` (雲端部署與維運專家) 綠燈放行上雲**
   - **觸發條件**: 前面三關 (Review, Test, Security) 皆給予綠燈 PASS。
   - **職責**: 執行 CI/CD 流程。如果是本地端部署，自動將修改 Push 到 Git 並觸發設定好的 Vercel / GitHub Actions；若尚未設定，則產出標準的 `Dockerfile` 或部署腳本，並教導 USER 安全設置 `.env` 環境變數。

## 🚀 使用方式

當手邊的功能宣告「開發完成」，準備合入主幹 (Main Branch) 或是推上雲端時：

```
/qa-deploy 我剛做完了購物車功能，請針對 shopping_cart.js 跟 checkout_api.js 進行三方聯合驗收，通過的話幫我設定好部署腳本。
/qa-deploy 準備發布 v2.0，請進行整體的資安與 Code 審查，並準備上線。
```

> **⚡ AI 行為準則**: 
> - **一票否決權 (Veto Power)**：在這條流水線中，任何一位專家發現嚴重瑕疵，必須立刻中斷流程，回報給 USER，並退回給 `/backend-dev` 或 `/frontend-dev` 要求重修。
> - **絕不妥協 (No Compromise)**：哪怕只是少了一個重要的 JSDoc 註解，或是 XSS 防護漏掉一個洞，也不允許「睜一隻眼閉一隻眼」放行部署。
