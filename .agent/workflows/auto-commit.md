---
description: 自動撰寫更新日誌、盤點變更，並將程式碼提交版本庫 (Git Commit) 或建立本地備份
---
# 📦 程式碼備份與日誌自動化 (/auto-commit)

這個工作流負責在每個開發階段（例如完成一個 Issue、一天的開發結束、或做完一次大型重構後），幫您自動盤點修改了哪些檔案、有條理地寫入 `CHANGELOG.md` 並進行 Git 提交或進行本地壓縮備份。

## 執行步驟：

### 1. 盤點變更狀態 (Analyze Target Changes)
1. 執行 `git status` 檢查目前有哪些檔案被修改、新增或刪除。
2. 針對被修改的核心檔案，檢閱您最近操作的紀錄或執行 `git diff`，總結出這次的變更重點（例如：解決了哪些 Race Condition、新增了哪支 API、重構了哪個頁面）。

### 2. 草擬更新日誌與 Commit Message (Draft Content)
1. 分析前一步驟的內容，草擬出準備更新到 `CHANGELOG.md` 的 Markdown 內容。請依照 `[Features]`, `[Enhancements]`, `[Bugfixes]`, `[Chores]` 進行分類。
2. 草擬出一句專業的 Git Commit Message 標題（格式遵照 Conventional Commits，如 `feat: xxx` 或 `fix: xxx` 或 `chore: xxx`）。

### 3. 使用者確認範圍 (User Confirmation)
將草擬好的 CHANGELOG 內容以及 Git Commit Message 顯示給使用者看，並清楚列出哪些檔案將被提交。
*💡 請務必詢問使用者：「請問這樣總結正確嗎？是否同意我直接執行 Git Commit？或是您需要額外將此版本打包成獨立的 `.zip` 備份檔？」*

### 4. 寫入檔案與執行備份 (Execute Commits & Backup)
當使用者同意後，請依序嚴格執行：
1. 更新專案根目錄的 `CHANGELOG.md`（將新紀錄**安插在最上方**，如果沒有該檔案則自動建立）。
2. 使用 `run_command` 執行 `git add .` (或特定檔案)。
3. 使用 `run_command` 執行 `git commit -m "<使用者的確認訊息>"`。
4. **(選用)**：若使用者要求，使用 `run_command` 建立包含當前日期的 ZIP 檔案（例如 `frontend_backup_202XMMDD.zip`）。

完成後，向使用者回報 Commit Hash 或備份檔案名稱，大功告成！
