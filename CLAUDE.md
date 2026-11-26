# CLAUDE.md — 專案指南（給 AI 協作與新進開發者）

## 專案是什麼

LINE Bot 管理後台：Cloudflare Worker（`worker_src/`）+ KV 儲存 + 原生 JS 前端（無框架、無 bundler）+ LIFF 認證。

## 目錄結構

```
worker_src/          後端（Cloudflare Worker）
  index.js           路由入口（auth → rate limit → handler 分派）
  handler/           各功能 API handler（17 個）
  lib/               LINE API 封裝、KV schema、工具
  middleware/        auth.js（LIFF 驗證）、permission.js（角色）、rate_limiter.js
js/ helper/ pages/ css/ index.html    前端（正式部署版本，由 worker site bucket 提供）
env/config.js        前端環境設定（apiBase、LIFF ID、debug 旗標）
tests/unit/          後端單元測試（node:test）
tests/helpers/       測試工具（mock_kv.mjs：記憶體版 KV mock）
                     mock_d1.mjs：Miniflare 真 D1，自動套用 migrations/*.sql
worker_src/bridge/   Bridge（垂直產品整合，BRIDGE_ENABLED=1 才啟用）；設計見 docs/integration/
migrations/          Bridge 的 D1 遷移，部署後由人在 D1 Console 手動套用
docs/                文件；docs/archive/ 放過期報告
wrangler.jsonc       Worker 設定（prod=pinti-line / dev=pinti-line-dev）
```

## 開發守則（TDD）

1. **改 `worker_src/` 之前先寫（或先改）對應的測試** — 測試放 `tests/unit/test_<模組名>.mjs`，用 `node:test` + `assert/strict`。
2. 需要 KV 的測試一律用 `tests/helpers/mock_kv.mjs` 的 `createMockKV()`，不要傳空 `env = {}`（那會走 fail-open 路徑，測不到真實行為）。
3. **`npm test` 必須全綠才能 commit**。CI（`.github/workflows/ci.yml`）會在 PR 上跑 `npm test` + `npx eslint worker_src tests --quiet`。
4. 修 bug 的流程：先寫一個會重現 bug 的失敗測試 → 修到綠 → 再 refactor。
5. 改 Bridge 端點（`worker_src/bridge/`）時一併更新 `docs/integration/bridge-v1.yaml`；契約測試（`test_bridge_contract_*.mjs`）會比對規格與真實回應，做法見 `docs/integration/gap-analysis.md` 的「契約測試」。

## 指令

```bash
npm test            # 單元測試（必須全綠）
npm run dev         # wrangler dev --env dev（本地 worker）
npx eslint worker_src tests --quiet   # 後端 lint（errors only，CI 會擋）
npm run deploy:check && npm run deploy
```

## 安全約定（修改時不可退步）

- **Fail-closed 原則**：`AUTH_MODE` 缺值時視同 `liff`（拒絕 X-User-Id fallback）；CORS 不可退回 `*`；`MIGRATION_SECRET` 未設定時 `/admin/migrate` 必須拒絕。
- 認證一律走 `withAuth`，授權一律走 `withPermission`（見 `team.js` 的用法），新 handler 不可直接信任 body/query 中的 userId/ownerId。
- HTTP 回應**不可**包含 `err.stack`。
- 前端不可新增裸 `innerHTML` 賦值（用 `helper/security.js` 的 `setInnerHTML`）。
- LM 與產品的分工以 `docs/integration/adr-001-lm-product-boundary.md` 為準（LM 管 LINE 管道，CRM 只在產品；契約只增不改）；不要提議在 LM 重做客人 CRM。下一版契約草案：`docs/integration/bridge-v1.1-draft.md`；開工計畫（LM-4A/4R/4D/4B/4C）：`docs/integration/lm-4-plan.md`；各 LINE 功能放哪：`docs/integration/lm-product-feature-map.md`；產品申報 Rich Menu 動作清單的草案（LM-5A，待決定）：`docs/integration/lm-5a-plan.md`。
- Bridge 邊界：只經 `worker_src/lm_service.js` 使用 LM；SQL 只寫在 `bridge/db.js`；LINE userId 不進任何回應、稽核或 log。測試（`test_import_boundary`、`test_bridge_db_boundary`）會擋。

## 已知狀態與陷阱

- `line-admin/` 已於 2026-06 移除（曾是前端的發散複本）；如需查舊版，看 git 歷史。
- dev 與 prod 使用不同的 KV namespace。**本地開發看不到正式資料**，測試需要的資料要自己寫進 dev namespace。`tests/unit/test_wrangler_config.mjs` 會擋住再次指回正式環境。
- ESLint 對前端 `js/`、`helper/` 還有大量遺留 errors/warnings；CI 只強制後端。前端清完一個目錄就把它加進 CI 的 lint 範圍。
- LM ↔ IP 整合進度與待辦（誰先誰後、哪邊做）：`docs/integration/ops-checklist-ip.md`，動到整合就更新它。
- 完整評估與路線圖：`docs/PROJECT_REVIEW_2026-06-11.md`；問題追蹤：`ISSUES.md`。

## 給 AI 的工作方式建議

- 機械性批量修改（清 console、搬檔案）→ 用腳本或便宜模型；架構/安全改動 → 先進 plan mode。
- 一個任務一個 session；範圍講清楚（檔案路徑 + 預期行為）。

## 回報方式（Tim 指定）

- **工作中不要旁白進度**：不寫「現在做前端」「後端綠了」「commit 沒成功，改用 merge」這類過程訊息，直接做。
- 只在兩種時候開口：**完成時**（結果、要 Tim 做的事、要 Tim 決定的事）或**卡住需要決定時**。
- 過程細節（工具被擋、git 改用別的方式推、測試中途紅過）不回報，除非影響結果或需要 Tim 處理。
- 一律用繁體中文，精簡、先講結論。
- **有 D1 遷移時，直接在回覆裡貼出要執行的 SQL**（去掉註解、依檔名順序、可整段複製到 D1 Console），並寫清楚要貼在哪些資料庫（bridge-db 與 bridge-db-dev）和「先貼再部署」；不要只說「去貼某某檔案」。
