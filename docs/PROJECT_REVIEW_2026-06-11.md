# LINE Bot 管理平台 — 全面嚴格評估報告

**審查日期**: 2026-06-11
**審查範圍**: 全 codebase（worker_src 後端 + 前端 + repo 衛生 + 測試）
**審查方式**: Claude Code 多 agent 平行審查 + 人工驗證關鍵發現（所有 Critical 級發現皆經實際讀碼/跑測試確認）

---

## 一、專案概況

| 項目 | 數據 |
|---|---|
| 定位 | LINE Bot 管理後台（Cloudflare Worker + KV + 原生 JS 前端 + LIFF 認證） |
| 總檔案數 | 341（不含 node_modules） |
| JS 總行數 | ~46,800 行 |
| HTML 總行數 | ~12,400 行 |
| 後端 | worker_src/（handler 17 個、lib 14 個、middleware 3 個） |
| 前端 | index.html + js/ + helper/ + pages/ + css/，**外加近乎完整複本 line-admin/** |
| 測試 | 66 個單元測試：**60 過、6 失敗** |
| 框架/打包 | 無框架、無 bundler、無 minify、無 CI |

---

## 二、嚴厲評估（分面向評分）

### 2.1 後端架構 — 評分：C+

**好的部分**：handler/lib/middleware 分層清楚；`withAuth`/`withPermission` 高階函數模式正確；wrangler secrets 用 `wrangler secret put` 而非硬編碼；race condition 有文件化說明。

**問題**：

1. **`lib/line_client.js` 與 `lib/line_api.js` 功能重疊**——retry 邏輯只有一邊有，push 與 reply 的錯誤處理不一致。
2. **路由模式不一致**：有的 handler 自帶 `route()`（token.js、tag.js），有的直接寫在 index.js（tier.js），參數傳遞方式各異。
3. **God file**：`event_handler.js` 434 行、`team.js` 409 行、`richmenu.js` 390 行，權限/成員/邀請邏輯混在一起。
4. **KV 當主資料庫的天花板**：`tier_system.js:94` 的 `KV.list({prefix})` 沒有 cursor 分頁，超過 1000 keys 就會漏資料；read-modify-write 全面存在 race condition（member、tag、rate limiter），目前無任何緩解（無 Durable Object、無樂觀鎖）。
5. **dev 與 prod 共用同一個 KV namespace ID**（wrangler.jsonc）——dev 測試會直接污染正式資料，這是資料事故等著發生。
6. **硬編碼外部網域**：`line_client.js:77` 寫死 `pinti-line-imagemap-url-redirect.hotichen.workers.dev`，應改環境變數。

### 2.2 安全 — 評分：C（曾更糟，近期修補有效，但仍有實質缺口）

**已驗證為「已修好」的**（agent 初步報告有誤判，經人工確認更正）：
- ✅ LIFF 模式下 `X-User-Id` fallback **已被拒絕**（auth.js:84-87，SEC-002 修補確實存在）。失敗的測試是「測試本身過時」，期待的是舊的寬鬆行為。
- ✅ ISSUES.md 中 SEC-001~006 大多已標記完成且程式碼吻合。

**仍存在的真實問題**（依嚴重度）：

| # | 嚴重度 | 問題 | 位置 |
|---|---|---|---|
| S1 | 🔴 高 | `AUTH_MODE` 未設定時**預設 legacy**（fail-open）：`env.AUTH_MODE \|\| "legacy"`，任何環境只要漏設這個 var，X-User-Id 就能直接冒充任何人 | auth.js:66 |
| S2 | 🔴 高 | LINE channel access token **明文存 KV**（`access_tokens_${userId}`），KV 外洩 = 所有 bot 被接管 | token.js:39-48 |
| S3 | 🔴 高 | `member.js` handler 接受 `ownerId` 參數但**沒有 `withPermission` 驗證**，與 team.js 的做法不一致——知道 botId 的已認證用戶可操作他人成員 | member.js:21-100 |
| S4 | 🔴 高 | CORS 未設 `ALLOWED_ORIGIN` 時**預設 `*`** | lib/utils.js:33-47 |
| S5 | 🟠 中 | 31 處 `request.json()` 無 schema 驗證；`project` 等欄位直接拼進 KV key，`"a:b:c"` 之類輸入可造成 key 碰撞 | token.js、keyword_reply.js 等 |
| S6 | 🟠 中 | 錯誤回應洩漏 `err.stack`（內部路徑/函數名外洩） | richmenu.js:69-70 |
| S7 | 🟠 中 | `LINE_CHANNEL_SECRET`、`MIGRATION_SECRET` 僅靠註解提醒，無啟動時檢查；漏設時 webhook 驗簽/migration 防護形同虛設 | wrangler.jsonc、webhook.js、migrate.js |
| S8 | 🟠 中 | 前端硬編碼外部上傳端點 `uploadimage2wordpress.hotichen.workers.dev`，繞過所有 API 認證/記錄 | helper/message.helper.js:248 |
| S9 | 🟠 中 | `debug` 模式（localhost 偵測）直接停用 LIFF 認證 + `testUserId` 後門；localhost 偵測失準（proxy 環境）= 靜默繞過認證 | env/config.js、api.client.js:102 |
| S10 | 🟡 低 | 63 處 `innerHTML` 賦值；`safeHTML()` 在 DOMPurify 未載入時**警告後仍回傳原始 HTML**；index.html 無 CSP | helper/security.js:19、各 builder |

### 2.3 測試與品質保證 — 評分：D

這是全專案最危險的面向，因為它讓其他問題不可見：

1. **測試套件與程式碼脫節**：6 個失敗測試中，auth 那個是「程式碼已修好、測試還在驗舊行為」；rate limiter 那 5 個是「程式碼改成 KV-backed、測試沒給 KV mock（傳空 `env={}`），永遠走 fail-open 路徑」。**結論：紅燈已被常態化。** 一旦團隊習慣 `npm test` 有 6 個紅燈，真正的 regression 出現時沒有人會發現。
2. **覆蓋面極窄**：只測 middleware/lib（auth、permission、kv_schema、migration、rate_limiter、utils），**17 個 handler 零測試**、event 處理零測試、前端零測試。
3. **無 CI**：沒有 GitHub Actions，測試失敗不擋 merge/deploy。
4. `package.json` 缺 `"type": "module"`，每次跑測試都觸發 reparse 警告。
5. Rate limiter 本身：KV fixed-window 實作合理且 race condition 有誠實註記，但 (a) KV 錯誤時 fail-open、(b) 每個請求多 2 次 KV 操作（read+put）的成本、(c) 完全沒有通過任何測試驗證過。

### 2.4 前端 — 評分：D

1. **`line-admin/` 是根目錄前端的不完美複本（最大的單一技術債）**：~90+ 檔案、約 40-50% 的有效程式碼重複。更糟的是**已經發散**——根目錄的 `js/main.js` 有 BUG-002 AbortController 修補與安全的 createElement 寫法，`line-admin/js/main.js` 沒有（還在用 innerHTML 模板字串）。安全修補只修了一邊。哪個目錄是正式上線版本？wrangler.jsonc 的 site.include 只包含根目錄，那 line-admin/ 是什麼？沒有任何文件回答這個問題。
2. **God files**：`flow_designer.js` **5,357 行**、`richmenu.js` 1,934、`flex_builder.js` 1,725——前 5 大檔案佔全部 JS 的 65%。
3. **無建置流程**：無 bundler、無 minify、無 tree-shaking，41K 行 JS 原樣上線；21 個頁面靠 runtime 動態 import 逐一 fetch。
4. **206 處 `console.*`** 留在正式碼（flow_designer 57 處）——之前 commit 訊息說「Remove all console.log statements (325 removed)」，顯然又長回來了，因為**沒有 lint rule 擋**。
5. **狀態管理原始**：userId 明文放 localStorage、畫布狀態塞 sessionStorage（19 處）、模組全域變數、DOM 本身當資料源，四者並存。
6. index.html 內嵌 196 行 CSS + `document.write()` 載入 LIFF SDK。

### 2.5 Repo 衛生與文件 — 評分：D

1. **三個無副檔名的 zip 檔被 commit 進 git**（`ziCq0Gx4` 280KB、`ziIGCCxw` 274KB、`ziTH0DGC` 44KB）——.gitignore 有 `*.zip` 但這幾個沒有副檔名所以漏掉。內容是舊版 index.html 備份。
2. **文件散落且互相矛盾**：TODO.md（28KB）、ISSUES.md、CHANGELOG.md、DEPLOY.md、project_report.html（51KB）、flow_designer 報告 v1+v2、docs/ 下 5 份 review report——沒有單一事實來源，部分內容已過期（TODO 說 console.log 已清完）。
3. 根目錄混入 `mock_server.js`、`run-audit.js`、`UI_INTEGRATION_TEMPLATE.html`、screenshot/ 等開發雜物。
4. `.eslintrc.json` 與 `eslint.config.js` 並存（新舊格式同時存在）。
5. **沒有 CLAUDE.md**——每次 AI 協作都要重新探索專案，浪費 token（見第四節）。

### 總評

> **目前狀態不建議作為正式產品上線。** 不是因為單一漏洞（多數 Critical 已修），而是因為三件結構性問題的疊加：(1) 測試紅燈常態化 + 無 CI，等於沒有安全網；(2) line-admin/ 雙份程式碼已發散，安全修補只覆蓋一半；(3) fail-open 的預設值文化（AUTH_MODE、CORS、rate limiter、DOMPurify fallback 全部預設放行）。

---

## 三、改進方向（依優先序的可執行路線圖）

### P0 — 本週內（止血，估 1-2 天）

| # | 行動 | 為什麼 |
|---|---|---|
| 1 | **修復 6 個過時測試**（auth 測試改驗新行為；rate limiter 測試加 KV mock），`package.json` 加 `"type": "module"` | 讓 `npm test` 回到全綠，紅燈才有意義 |
| 2 | **建 GitHub Actions CI**：push/PR 跑 `npm test` + eslint | 沒有 CI，所有修補都會再次腐化 |
| 3 | **決定 line-admin/ 的命運並執行**：確認正式部署用哪份 → 把另一份刪除（git 歷史還在，不會真的遺失）；若兩者必須並存，寫清楚原因 | 雙份發散是目前最大風險放大器 |
| 4 | 刪除三個 zip 檔（`git rm ziCq0Gx4 ziIGCCxw ziTH0DGC`），.gitignore 補 `zi*` 規則 | repo 衛生 |
| 5 | **Fail-open 改 fail-closed**：`AUTH_MODE` 預設改 `liff`（或缺值時直接 throw）；CORS 缺 `ALLOWED_ORIGIN` 時拒絕而非 `*`；worker 啟動時檢查 `LINE_CHANNEL_SECRET`/`MIGRATION_SECRET` 存在 | 一行設定漏掉不該等於全開 |
| 6 | `member.js` 補上 `withPermission` 包裝（比照 team.js） | 已認證用戶可橫向越權 |

### P1 — 兩三週內（補強，估 3-5 天）

7. **錯誤回應移除 `err.stack`**，統一走 error handler；後端 console.* 收斂到 logger。
8. **`request.json()` 加輕量 schema 驗證**（不必引大型套件，寫一個 30 行的 `validate(body, shape)` 即可），KV key 組件過濾 `:` 等分隔符。
9. **token 加密存放**：用 Workers 的 `crypto.subtle` AES-GCM + 一個 `wrangler secret` 金鑰包住 access token。
10. **dev/prod 分離 KV namespace**（wrangler 建第二個 namespace）。
11. **ESLint 規則自動化防腐**：`no-console`（CI 擋）、自訂 rule 或 grep 檢查裸 `innerHTML`；這比再做一次「人工清 325 個 console.log」有效得多。
12. 合併 `line_client.js`/`line_api.js`；`KV.list` 補 cursor 分頁。
13. 前端硬編碼上傳端點移到 env/config.js，並在後端加 proxy 端點以納入認證。

### P2 — 一兩個月內（體質改善）

14. **引入 Vite**：先只做 bundle+minify（不改框架），index.html 內嵌 CSS 抽出，加上 CSP header。
15. **拆 god files**：flow_designer.js 拆成 canvas-render / node-edit / serialize / persist 四模組；richmenu、flex_builder 同理。每拆一塊就補對應測試。
16. **handler 層測試**：用 Miniflare/`unstable_dev` 對 17 個 handler 補最小 happy-path + 授權測試。
17. **文件收斂**：TODO.md + ISSUES.md 合併為單一 ISSUES.md（或改用 GitHub Issues）；過期報告移入 docs/archive/；新增 CLAUDE.md。
18. 長期：若 flow designer 要繼續長，評估該頁單獨遷移到 Vue/Svelte（不必全站重寫）。

---

## 四、Agents / Model 經濟高效使用指南

> 目標：用最少的 token 花費完成上面的路線圖。原則只有一條：**模型的智力要配對任務的難度，context 要配對任務的範圍。**

### 4.1 模型價目與適用場景（2026-06 現價，每百萬 token）

| 模型 | 輸入 | 輸出 | 在本專案的用途 |
|---|---|---|---|
| Haiku 4.5 | $1 | $5 | 機械性批量改動：清 console.*、改 import 路徑、跑搜尋類 subagent |
| Sonnet 4.6 | $3 | $15 | **日常主力**：修測試、加 schema 驗證、寫 CI yaml、拆中型模組——P0/P1 的 80% 工作 |
| Opus 4.8 | $5 | $25 | 架構級工作：拆 flow_designer、設計 token 加密方案、安全審查、Claude Code 預設值 |
| Fable 5 | $10 | $50 | 只留給最難的長程任務（例如一次過夜跑完整個 P1 清單並自我驗證）；注意其 tokenizer 同樣內容多耗 ~30% token |

**省錢的最大槓桿不是模型單價，而是 context 大小**——同一個問題，在塞滿 10 萬 token 歷史的 session 裡問，比在乾淨 session 裡問貴一個數量級。

### 4.2 Claude Code 實戰守則（按省錢效果排序）

1. **先建 CLAUDE.md（一次性投資，回報最高）**。用 `/init` 產生，寫明：專案結構、`line-admin/ 是 X 請勿動`、測試怎麼跑、已知的 6 個測試狀態、KV schema 約定。沒有它，每個新 session 都要花 2-5 萬 token 重新探索專案——這份報告的審查過程本身就證明了這點。
2. **能用腳本就不要用 LLM**。清 console.log、刪 zip、改 .gitignore 這類事，讓模型寫一個 10 行腳本（一次花費），而不是讓模型逐檔編輯 23 個檔案（23 次花費）。歷史教訓就在眼前：上次人工清了 325 個 console.log，現在又長回 206 個——**正解是 ESLint rule + CI，零 token 的永久防腐**。
3. **一個任務一個 session，做完就 `/clear`**。把 P0 的 6 項當 6 個獨立 session 跑，每個 session 的 context 只含相關檔案。不要在同一個對話裡從修測試聊到拆前端。
4. **用 `/model` 動態切換**：開 session 先用 Sonnet 做完機械部分，遇到設計決策再切 Opus 問那一題。Claude Code 訂閱制（Pro/Max）下，用低階模型同樣延長你的額度。
5. **搜尋/盤點交給 subagent（Explore/Task）**：subagent 在自己的 context 裡讀幾十個檔案，只把結論帶回主對話——主對話 context 保持小，後續每一輪都省。本報告即是用兩個平行 Explore agent 完成全 codebase 盤點，主對話只收結論。
6. **大改動先進 Plan mode**（Shift+Tab）：拆 flow_designer 這種事，先讓模型只讀不寫、產出計畫、你核准後才動手——避免「寫了 3 萬 token 的錯誤方向然後重來」這種最貴的浪費。
7. **平行化獨立工作**：互不相干的任務（如「修 rate limiter 測試」和「寫 CI yaml」）可用背景 agent 同時跑。
8. **用現成 skill 而非自由發揮**：`/security-review`（上線前掃一次）、`/code-review`（PR 前）、`/simplify`——它們的 prompt 已調優，比自己描述需求省往返。
9. **`/fast` 模式**：Opus 的快速輸出模式（不降智力），互動式修小東西時體感更好；長任務交背景跑即可不必開。
10. **明確指定範圍**：「修 `tests/unit/test_rate_limiter.mjs`，給 checkRateLimit 一個 in-memory KV mock」比「把測試修好」便宜 5 倍——模型不用自己找檔案、猜意圖。

### 4.3 路線圖任務 × 模型配置建議

| 任務 | 建議模型 | 模式 | 理由 |
|---|---|---|---|
| P0-1 修 6 個測試 | Sonnet | 單 session | 範圍明確，照測試錯誤訊息改 |
| P0-2 CI yaml | Sonnet/Haiku | 單 session | 模板化工作 |
| P0-3 刪 line-admin | **你決定 + Haiku 執行** | — | 決策是人的事；執行是 `git rm -r` |
| P0-5 fail-open→fail-closed | Sonnet | 單 session + `/code-review` | 小 diff 但安全敏感，review 一次 |
| P1-9 token 加密 | Opus | Plan mode 先行 | 涉及金鑰管理與遷移既有資料 |
| P1-11 ESLint 防腐 | Sonnet | 單 session | 寫 rule + 修 CI |
| P2-15 拆 flow_designer | Opus（或 Fable 過夜跑） | Plan mode → 分段執行 | 5,357 行的重構，錯誤成本高 |
| P2-16 handler 測試 | Sonnet 批量 + Opus 抽查 | 每 3-4 個 handler 一個 session | 重複模式，Sonnet 足夠 |
| 上線前 | Opus | `/security-review` | 一次性，值得用好模型 |

### 4.4 一個量級感

以本次審查為例：兩個 Explore subagent 合計約 16 萬 token 完成 5 萬行碼的全面盤點。若在主對話裡逐檔閱讀，光 context 累積就會超過 50 萬 token 且品質更差。**「小 context 的主對話 + 用後即棄的 subagent」是這個 codebase 規模下最重要的成本結構。**

---

*本報告由 Claude Code 產生；所有標記為「已驗證」的發現均經直接讀碼或執行測試確認，agent 初步審查中的兩處誤判（auth fallback、rate limiter「失效」）已更正並在 2.2/2.3 節說明。*
