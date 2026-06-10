# Pinti LINE - 部署指南

## 首次部署前必做

### 1. 設定 Cloudflare Secrets

```bash
# 設定 Migration API 密鑰（自行產生一個強密碼）
npx wrangler secret put MIGRATION_SECRET

# 可選：設定 LIFF Channel ID
npx wrangler secret put LIFF_CHANNEL_ID
```

### 2. 切換認證模式

`wrangler.jsonc` 中已設定：
- 正式環境：`AUTH_MODE: "liff"`
- dev 環境：`AUTH_MODE: "legacy"`

正式部署前確認：
- 前端 LIFF SDK 已正確初始化
- `helper/api.client.js` 會自動發送 Bearer token
- 使用者可透過 LINE Login 正常登入

### 3. 執行 Pre-Deploy 檢查

```bash
npm run deploy:check
```

## 部署流程

```bash
# 1. 執行 pre-deploy 檢查
npm run deploy:check

# 2. 執行單元測試
npm test

# 3. 部署到 Cloudflare Workers
npx wrangler deploy

# 4. 驗證部署
curl https://your-worker.workers.dev/debug-ping
```

## 開發環境

```bash
# 啟動本地開發伺服器
npm run dev

# 執行單元測試
npm test

# 執行安全性整合測試（需要 wrangler dev 運行中）
npm run test:security
```

## 環境變數說明

| 變數 | 類型 | 說明 |
|------|------|------|
| AUTH_MODE | var | `liff`（正式）或 `legacy`（開發） |
| LIFF_ID | var | LIFF App ID |
| MIGRATION_SECRET | secret | Migration API 驗證密鑰 |
| LIFF_CHANNEL_ID | secret | LIFF Channel ID |

## 回滾

如果部署後發現問題：

```bash
# 回滾到上一版本
npx wrangler rollback
```

## 疑難排解

1. **檢查登入狀態**：`npx wrangler whoami`
2. **查看即時 Log**：`npx wrangler tail`
3. **檢查 Secrets**：`npx wrangler secret list`

## 注意事項

- **永遠不要**在 `wrangler.jsonc` 中寫入 secrets
- 正式環境的 `AUTH_MODE` 必須是 `"liff"`
- Migration API 只應在資料遷移時使用，遷移完成後可考慮移除路由
- Rate limiter 使用 in-memory 方式，Worker 重啟後計數器會重置（預期行為）
