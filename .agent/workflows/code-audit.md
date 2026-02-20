---
description: 程式碼審計 - 執行全面程式碼質量檢查、命名規範與邏輯驗證
---

# 程式碼審計模式 (Code Audit)

使用全域審計規則對指定的檔案或整個專案進行深度體檢，確保一致性與功能完整性。

## 審計重點

依據 `GEMINI.md` 中的全域規範執行：
1. **Consistency (一致性)**：檢查 API 呼叫與錯誤處理模式。
2. **Naming (命名)**：驗證 `camelCase`、`PascalCase` 與 `SCREAMING_SNAKE_CASE`。
3. **Annotations (註解)**：強制要求 `Pre-conditions` 與 `Post-conditions` 註解。
4. **Logic (邏輯)**：優化為 `Early Return` 並檢查錯誤擷取。
5. **Style (樣式)**：執行 `const/let` 規範與 ES6+ 語法。
6. **Functionality (功能性)**：確保重構後功能與原本 100% 相同。

## 使用方式

```
/code-audit 檢查 member.js 的命名與註解
/code-audit 審核此專案的 API 調用一致性
/code-audit 優化這段邏輯並補齊 Pre/Post 註解
```

AI 將詳細分析並在修改前提供變更說明的邏輯對比，保證行為不變性。
