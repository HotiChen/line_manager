# 部署指南 (Deployment Guide)

本專案使用 [Cloudflare Workers](https://workers.cloudflare.com/) 作為後端服務。

## 事前準備 (Prerequisites)

- **Node.js**: 請確保您的電腦已安裝 Node.js。
- **Cloudflare 帳號**: 您必須透過 Wrangler 登入 Cloudflare。

## 如何部署 (How to Deploy)

若您修改了 `src` 目錄下的後端程式碼，請在終端機執行以下指令來部署更新：

```bash
npm run deploy
```

這個指令會執行 `wrangler deploy`，它會自動完成以下步驟：
1.  將 `src/index.js` 打包。
2.  上傳至 Cloudflare。
3.  更新線上的 Worker 服務 (`pinti-line`)。

## 設定檔 (Configuration)

部署相關的設定位於 `wrangler.jsonc` 檔案中。主要設定包含：

- **name**: `pinti-line` (Cloudflare 上的 Worker 名稱)
- **main**: `src/index.js` (程式進入點)
- **kv_namespaces**: Cloudflare KV 儲存空間的設定 (`KV_LINE_STORAGE`)。

## 疑難排解 (Troubleshooting)

如果部署失敗：
1.  **檢查登入狀態**: 執行 `npx wrangler whoami` 確認是否已登入。
2.  **查看 Log**: 執行 `npx wrangler tail` 可以查看 Worker 的即時執行紀錄，協助除錯。
