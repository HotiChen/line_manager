# LM ↔ IP（Image Picker）整合操作表

最後更新：2026-11-26。每次動到整合就更新這張表；換 session 先讀它。
兩邊的分工原則見 `adr-001-lm-product-boundary.md`；LM 這側的設計見 `lm-4-plan.md`。

## 基本資料（非機密）

| 項目 | 值 |
|---|---|
| 產品 | Image Picker（IP），repo `HotiChen/imge_picker`，Worker `imagepicker` |
| product_id / product_key | `prd_cff6b79e5038` / `ip` |
| LM Worker | `pinti-line`（prod）、`pinti-line-dev` |
| 事件網址（LM → IP） | `https://imagepicker.hotichen.workers.dev/api/line/events` |
| 身分導回（LM → IP） | `https://imagepicker.hotichen.workers.dev/api/line/identity` |
| 授權 scopes | `link:manage` `contacts:bind` `messages:send` `segments:write` `events:receive` `identity:read` |
| LIFF（LM 建立） | `https://liff.line.me/1661215693-0Y7057vq`（LINE Login channel `1661215693`） |

密鑰只存在 Worker secret：LM 的 `BRIDGE_ADMIN_SECRET`、`TOKEN_ENCRYPTION_KEY`；IP 的 `LM_PRODUCT_SECRET`、`LM_EVENT_SIGNING_SECRET`（`wrangler secret put` 一定要在對的 repo 目錄下執行，確認輸出的 Worker 名稱）。

## 已完成（含驗證方式）

| 項目 | 哪邊 | 狀態 |
|---|---|---|
| Bridge、事件轉送、分眾、備用訊息、LINE 身分的程式 | LM | 已合併；單元測試 |
| D1 遷移 0001–0007（`bridge-db`，正式） | LM | 2026-11-26 查 `sqlite_master` 與欄位：14 張表、13 個 index、四個 ALTER 欄位都在 |
| 部署 LM（#47 訊息回傳輸入框、#48 imageFile、#49 label 20 字） | LM | 2026-11-26 01:57（+08）已部署；線上 `helper/action_label.js`、`helper/message.helper.js` 的 md5 與本地一致。測試 2094 pass、`eslint worker_src tests` 乾淨、`deploy:check` 15 通過 |
| `WEBHOOK_GLOBAL_SECRET_DISABLED=1` | LM | 已部署 |
| IP 產品登記、六個 scopes、event_url、identity_return_uris、url_domains | LM（營運 PATCH） | PATCH 回應已確認 |
| 事件簽章密鑰（已輪替）放在 IP Worker `imagepicker` | IP | Tim 確認 |
| IP 重新連結（拿到新 scopes） | IP | 後台「已連結的產品」顯示六個權限 |
| 後台「系統整合」頁：備用訊息、LINE 身分 | LM | 手機與桌機看過 |
| 備用訊息 `plans`、`status` | LM | 已設；2026-11-26 Tim 把測試字（`hi`、`hihi`）換成正式文字 |
| LINE 身分（Login channel 1661215693 + LIFF）已啟用 | LM | 後台顯示「已啟用」，手機驗證通過 |
| LIFF → LM 驗證身分 → 導回 IP | LM | 實測：手機停在 IP 的 `/api/line/identity`。這同時驗證了：LINE Login token 可建 LIFF、LIFF 轉送 `p` 參數、ID token 驗證 |
| IP 遷移 `2026-11-25-client-sessions.sql` | IP | 2026-11-26 查：線上 `/api/mine` 回 401（未套用時會是 503），schema probe 過 |
| IP 的 L2 安全審查（第二次、獨立） | IP | 2026-11-26 完成，審 `main` 的 `fad624f`。結論：pilot 範圍（只有 Tim 一位攝影師）**沒有阻擋上線的漏洞**；身分換 ref、session、view 連結、旗標 fail-closed、userId／身分碼／token 不外洩五項都過。報告 `docs/l2-my-photos-security-review.md`，commit `83e551f` 在分支 `review/l2-security`，**還沒 push** |
| `LINE_MY_PHOTOS = "on"` 並部署 | IP | `origin/main` 的 `worker/wrangler.toml:78` 已是 `"on"`（`fad624f`，2026-11-25 Tim）；2026-11-26 查線上 `/api/line/identity` 回 302 → `mine.html#e=expired`（旗標關時會是 `{"error":"Not found"}`），確認已部署 |
| Rich Menu 兩個「訊息回傳」按鈕 `px:ip:plans`、`px:ip:status`，已同步 | LM 後台 | 2026-11-25 夜 Tim 設好並手機實測，IP 有回覆。備用訊息那條路徑沒單獨測（IP 正常回應時不會走到） |
| Rich Menu「我的相片」網址按鈕 `https://liff.line.me/1661215693-0Y7057vq?p=ip` | LM 後台 | 2026-11-25 夜 Tim 設好 |
| 手機實測「我的相片」（已綁定客人） | 手機 | 2026-11-25 夜通過。未綁定客人的畫面（`mine.html#e=bind`）還沒看過 |
| D1 遷移補齊（`bridge-db-dev`，開發） | LM | 2026-11-26 Tim 在 D1 Console 補貼 0003、0004 與 0005 漏掉的 `ALTER TABLE contacts ADD COLUMN segment`；查 `sqlite_master` 得 14 張表（不含 `_cf_KV`、`sqlite_sequence`）、13 個 index，`bind_codes`、`contacts`、`counters`、`flags` 都在，`bind_codes.allow_rebind`、`contacts.segment`、`products.product_key` 三個欄位都在 —— 與正式庫 `bridge-db` 一致 |

## 還沒做（依順序）

| # | 項目 | 哪邊 | 備註 |
|---|---|---|---|
| 1 | 確認未綁定客人的「我的相片」畫面 | 手機 | 未綁定會導到 `mine.html#e=bind`。已綁定那條路徑 2026-11-25 夜實測過 |
| 2 | 處理 L2 審查的三個「應修」 | IP | ①identity 節流只有全站 key、沒有 per-IP ②公開路由每次請求跑無索引全表 DELETE，且在 cap 之前 ③`main` 上兩個 D1 statement 預算測試是紅的（3028/3030），10 分鐘 cron 距上限只剩 8 句 |
| 3 | push `review/l2-security` 或把報告併進 `main` | IP | 報告目前只在本機 |
| 4 | L3 分眾（IP → LM `PUT /contacts/{ref}/segment`）實測，再決定要不要設 `ip:<segment>` 的 Rich Menu 規則 | 兩邊 | 目前沒有設定任何分眾規則 |
| 5 | **加入第二位攝影師之前必修**：審查發現 4，`LINE_IDENTITY_TRIES` 的候選迴圈會用 A 的連結金鑰去兌換可能屬於 B 的碼 | IP | 程式自己已寫明這件事；單一攝影師的 pilot 不受影響 |

## 待你決定／已知小事

- ~~`pinti-line` 上誤放的 `LM_EVENT_SIGNING_SECRET`~~：2026-11-26 查 `wrangler secret list`，`pinti-line` 只剩 `BRIDGE_ADMIN_SECRET`、`BRIDGE_ENABLED`、`LINE_CHANNEL_SECRET`、`TOKEN_ENCRYPTION_KEY` —— 已經不在了，這件事結案。
- 「已連結的產品」頁會列出所有已撤銷與測試連結，要不要收合已撤銷的。
- 稽核欄位 `actorId` 的規則與 CLAUDE.md 的差異，尚未決定。
- CI 偶發 1 個測試失敗（2026-11-25，重跑變綠），沒查出是哪一個。
- IP 的 L2／L3 在 LM 這邊沒有審查過。

## 操作備忘

- 登記產品／改權限是營運操作（`BRIDGE_ADMIN_SECRET` + `PATCH /bridge/v1/admin/products/{id}`），scopes 與 `url_domains` 只增不減；要重新連結才會拿到新 scope。
- 在 LM 後台找：側邊選單「系統整合」，頁面下方「已連結的產品」→「備用訊息」，再往下是「LINE 身分（我的相片）」。
- **IP 的資料夾有兩層同一個 repo 的 checkout**：`~/Desktop/Claude code/imge_picker`（外層，HEAD 停在 `db03cf6`，`worker/wrangler.toml` 裡連 `LINE_MY_PHOTOS` 都還沒有）與 `~/Desktop/Claude code/imge_picker/imge_picker`（內層，現行版本）。部署或跑遷移前先 `git log --oneline -1` 確認在內層，不然會部到舊版。
