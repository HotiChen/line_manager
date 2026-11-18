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
                     dom_env.mjs：jsdom + 真 DOMPurify（前端 DOM 層測試，見 test_flow_designer_dom.mjs）
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
- Bridge 邊界：只經 `worker_src/lm_service.js` 使用 LM；SQL 只寫在 `bridge/db.js`；LINE userId 不進任何回應、稽核或 log。測試（`test_import_boundary`、`test_bridge_db_boundary`）會擋。

## 已知狀態與陷阱

- `line-admin/` 已於 2026-06 移除（曾是前端的發散複本）；如需查舊版，看 git 歷史。
- dev 與 prod 使用不同的 KV namespace。**本地開發看不到正式資料**，測試需要的資料要自己寫進 dev namespace。`tests/unit/test_wrangler_config.mjs` 會擋住再次指回正式環境。
- ESLint 對前端 `js/`、`helper/` 還有大量遺留 errors/warnings；CI 只強制後端。前端清完一個目錄就把它加進 CI 的 lint 範圍。
- 完整評估與路線圖：`docs/PROJECT_REVIEW_2026-06-11.md`；問題追蹤：`ISSUES.md`。

## 給 AI 的工作方式建議

- 機械性批量修改（清 console、搬檔案）→ 用腳本或便宜模型；架構/安全改動 → 先進 plan mode。
- 一個任務一個 session；範圍講清楚（檔案路徑 + 預期行為）。
