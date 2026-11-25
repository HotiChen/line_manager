# LM ↔ IP（Image Picker）整合操作表

最後更新：2026-11-25。每次動到整合就更新這張表；換 session 先讀它。
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
| D1 遷移 0005／0006／0007（bridge-db 與 bridge-db-dev） | LM | Tim 確認都已套用 |
| `WEBHOOK_GLOBAL_SECRET_DISABLED=1` | LM | 已部署 |
| IP 產品登記、六個 scopes、event_url、identity_return_uris、url_domains | LM（營運 PATCH） | PATCH 回應已確認 |
| 事件簽章密鑰（已輪替）放在 IP Worker `imagepicker` | IP | Tim 確認 |
| IP 重新連結（拿到新 scopes） | IP | 後台「已連結的產品」顯示六個權限 |
| 後台「系統整合」頁：備用訊息、LINE 身分 | LM | 手機與桌機看過 |
| 備用訊息 `plans`、`status` | LM | 已設，內容目前是測試字（`hi`、`hihi`） |
| LINE 身分（Login channel 1661215693 + LIFF）已啟用 | LM | 後台顯示「已啟用」，手機驗證通過 |
| LIFF → LM 驗證身分 → 導回 IP | LM | 實測：手機停在 IP 的 `/api/line/identity`。這同時驗證了：LINE Login token 可建 LIFF、LIFF 轉送 `p` 參數、ID token 驗證 |

## 還沒做（依順序）

| # | 項目 | 哪邊 | 備註 |
|---|---|---|---|
| 1 | 部署 LM（含 #47 訊息回傳輸入框、#48 imageFile、#49 label 20 字） | LM | `git pull origin main` → `npm run deploy:check && npm run deploy` |
| 2 | Rich Menu 設兩個「訊息回傳」按鈕：`px:ip:plans`、`px:ip:status`，同步到 LINE | LM 後台 | 先用不是預設的選單測，同步會動線上畫面 |
| 3 | 手機實測 `px:` 按鈕：IP 有回就看到 IP 的回覆；IP 沒回看到備用訊息 | 手機 | 要驗備用訊息可暫時把 IP 事件網址改錯，測完改回 |
| 4 | 把備用訊息 `hi`／`hihi` 換成正式文字 | LM 後台 | |
| 5 | IP 跑遷移 `worker/migrations/2026-11-25-client-sessions.sql` | IP（D1 Console） | 先跑再部署 |
| 6 | IP 的 L2（「我的相片」）安全審查 | IP | IP 的 CLAUDE.md 規定：新的客人身分入口開旗標前要審查一次。**尚未做** |
| 7 | IP `worker/wrangler.toml` 的 `LINE_MY_PHOTOS` 改 `"on"` 並部署 | IP | 目前 `"off"`：此時 `/api/line/identity` 一律回 `{"error":"Not found"}`（設計如此，不是壞掉） |
| 8 | Rich Menu 設「我的相片」網址按鈕：`https://liff.line.me/1661215693-0Y7057vq?p=ip` | LM 後台 | `to` 參數 IP 目前不用（導回位置固定為 `mine.html`），可省略 |
| 9 | 手機實測「我的相片」整段，另外確認未綁定客人的畫面 | 手機 | |
| 10 | L3 分眾（IP → LM `PUT /contacts/{ref}/segment`）實測，再決定要不要設 `ip:<segment>` 的 Rich Menu 規則 | 兩邊 | 目前沒有設定任何分眾規則 |

## 待你決定／已知小事

- `pinti-line` 上誤放的 `LM_EVENT_SIGNING_SECRET`：舊值已因輪替失效，建議刪掉（`wrangler secret delete`）。
- 「已連結的產品」頁會列出所有已撤銷與測試連結，要不要收合已撤銷的。
- 稽核欄位 `actorId` 的規則與 CLAUDE.md 的差異，尚未決定。
- CI 偶發 1 個測試失敗（2026-11-25，重跑變綠），沒查出是哪一個。
- IP 的 L2／L3 在 LM 這邊沒有審查過。

## 操作備忘

- 登記產品／改權限是營運操作（`BRIDGE_ADMIN_SECRET` + `PATCH /bridge/v1/admin/products/{id}`），scopes 與 `url_domains` 只增不減；要重新連結才會拿到新 scope。
- 在 LM 後台找：側邊選單「系統整合」，頁面下方「已連結的產品」→「備用訊息」，再往下是「LINE 身分（我的相片）」。
