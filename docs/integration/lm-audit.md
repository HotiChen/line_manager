# LM 現況報告（WP-0A）

基準：`main` @ `68536d3`，`npm test` 802 項全過（報告後新增修復為 809 項）。
方法：唯讀盤點，每項附檔案與行號；無法由程式碼確認的標「無法確認」並說明怎麼確認。
範圍：只寫 LM 這一側，不含其他產品的內部細節。

## 1. Bridge 現有面

| 路由 | 認證 | 資料位置（`kv_schema.js`） |
|---|---|---|
| `POST/GET /api/v1/systems`、`PATCH/DELETE /api/v1/systems/{system}`、`POST …/keys/rotate` | LIFF（`index.js:129`）＋`withPermission(…,"owner")`（`systems.js:315`） | `bot:{id}:system:{name}`、`bot:{id}:systems`、全域 `service_key:{sha256}` |
| `POST /api/v1/messages/push`、`/multicast` | Bearer service key＋`X-Bot-Id`（`bridge_auth.js:112-151`）＋scope `messages:push` | 讀 `service_key:*`、`system:*`、`member:*`；寫 `idem:*`、`quota:*`、`sys_rl:*` |
| 其他 `/api/v1/*` | 404／405（`bridge_messages.js:305-306`） | — |

分派：`index.js:117-119`（系統路由）、`:180-182`（註冊路由）；分流判斷 `auth_routes.js:75-80`。

**缺少**（grep 確認，`worker_src` 內沒有實作）：audit log、product／client registry、一次性授權碼、link 物件、聯絡人綁定（外部代號 ↔ LINE userId）、受限通知格式。
`ALLOWED_SCOPES` 含 `members:read`、`tags:write`（`systems.js:24`），但沒有任何路由使用它們。

## 2. 資料模型

| 概念 | 實際內容 | 出處 |
|---|---|---|
| bot | LINE 官方帳號，botId = LINE 的 destination | `kv_schema.js:6-12` |
| owner | `bot:{id}:owner`；舊路徑 `destination_user_{id}` | `bot_context.js:158-166` |
| staff／member | `bot:{id}:permissions` = `{users:[{userId, role, …}]}` | `team.js:41-47` |
| 角色 | 實際只比對 `owner`，其餘都當成員 | `permission.js:55-66` |
| 使用者的 bot 清單 | `user:{id}:bots` = `{bots[], currentBotId}` | `team.js:333-358` |
| 舊 token | `access_tokens_{userId}` = `{[project]:{token(加密), destination, displayName}}` | `token_store.js:21-24` |

**沒有「商家／組織」這一層**：使用者直接擁有 bot（grep `merchant|tenant` 於 `worker_src` 無結果）。
角色值沒有白名單驗證（`team.js:27`、`:98`）。

## 3. 授權

- **有 bot 層級檢查（`withPermission`）**：`team.js` 大部分、`systems.js` 全部、`member.js` 的 demo 路由。
- **只信 LIFF userId＋`openBotStore(env, userId)`**：`member.js` 其餘、`tag`、`keyword_reply`、`flex`、`image_msg`、`imagemap`、`profile`、`quick_reply`、`tier`、`segmented_richmenu`、`push_message`、`/stats`；`bot`、`token`、`richmenu` 只用 userId；`flow.js` 直接拼 `flow_{userId}_{botId}_…`。
  這一組沒有角色區分：`member` 與 `owner` 權限相同。
- 本輪盤點發現並已修復兩項（`6383a62`）：邀請清單跨 bot 外洩；測試會員的 store 與權限檢查的 bot 不一致。細節見該 commit 與測試。
- 已知限制（非本次修復）：`/team/invite/accept` 的「已使用」旗標為 read-modify-write，KV 無原子操作（`team.js:219,268-276`）；`/admin/migrate` 以 query string 傳密鑰，且為非 constant-time 比較（`migrate.js:~536-545`）。

## 4. Service key／scope／撤銷

認證順序（`bridge_auth.js:112-151`）：KV binding → Bearer → `X-Bot-Id`（拒含 `:`）→ 以 SHA-256 查 `service_key:*`（不存在與已撤銷同一個 401）→ key 記錄的 botId 必須等於 `X-Bot-Id` → 系統紀錄存在且未停用 → scope。scope 取自 key 記錄，PATCH 不能改。

撤銷：key 記錄寫 `revokedAt`，保留 90 天（`systems.js:117-122`）；輪替順序為「發新 → 更新系統紀錄 → 撤銷舊」，故意讓失敗時不會鎖死使用者（`:278-279`）。

**可能讓 key 活過撤銷的點**
1. **KV 最終一致**：每次認證兩次 `get`，沒有快取設定，撤銷後在其他邊緣節點可能短暫仍有效。程式碼無法確認實際延遲，需實測（撤銷後在另一個 colo 呼叫）。
2. 認證不比對 `system.keyHash`；輪替第三步失敗時舊 key 仍有效（程式註解說明是刻意的）。
3. PATCH／rotate 對系統紀錄是 read-modify-write，併發可能覆寫 `keyHash`。
4. 建立系統非原子：兩個同時註冊同名系統可能各拿到一把 key，其中一把成為孤兒（仍可通過認證）。
5. 系統紀錄的 `rateLimit` 欄位沒有任何 API 可寫（`bridge_auth.js:144`）。

以上 1、3、4 的根因都是 KV 沒有原子操作，這也是改用 D1 的理由。

## 5. 對外發訊息的入口

`pushMessage`／`multicastMessage`（`line_api.js:229-250`，只依賴 token，失敗丟 `LineApiError`）；`replyWithRetry`（`line_client.js:129-170`，webhook 用）；`handleSendPushMessage`（`push_message.js:6-68`，後台用，會做 `(@name)` 變數替換）。

Bridge 實際用到 LM 內部的只有三件事（`bridge_messages.js:23-25,91-137`）：取 bot 的 token（`resolveOwner`＋`getAccessTokenForDestination`）、查會員是否存在、標記會員 `inactiveAt`。
**建議的窄介面**（`worker_src/lm_service.js`）：
```
getBotAccessToken(env, botId)               -> Promise<string|null>
hasMember(env, botId, lineUserId)           -> Promise<boolean>
markMemberInactive(env, botId, lineUserId)  -> Promise<void>
```

## 6. LINE userId 的來源

- webhook：`destination` 來自 body（`webhook.js:61`）；`event.source.userId`（`event_handler.js:54,190,329,375,391`）是 **Messaging API channel** 的 userId，作為會員 key。
- LIFF：`/v2/profile` 的 userId（`auth.js:54-68`）是 **LINE Login channel** 的 userId，作為 owner／staff 身分。全專案只有一個 LIFF app（`wrangler.jsonc:30-33`）。
- 兩個空間在程式中分開使用；會員自助註冊（`member.js:45`）是例外，會把 LIFF userId 寫成會員 key。
- **無法確認**：LIFF channel 與各 OA 是否同一個 Provider。repo 內沒有 Provider 資訊。確認方式：LINE Developers Console 查看各 channel 所屬 Provider。
- **後果**：LINE userId 在不同 Provider 下是不同的值，所以「用 LINE Login 取得客戶 userId」只有在 OA 與 LINE Login 同一 Provider 時才可靠。採用「綁定碼訊息」（客戶把碼傳給 OA，由 webhook 取得 userId）可以完全避開這個前提。

## 7. Bindings、設定、D1

- KV：`KV_LINE_STORAGE`（prod `wrangler.jsonc:6-9`，dev 獨立 namespace `:48-56`）；Workers Sites 模式（`site.bucket`），wrangler 3.114.17，`compatibility_date` 2025-04-13；沒有 queue binding。
- 程式有讀、但未在 `wrangler.jsonc` 宣告的（secret／選用）：`LINE_CHANNEL_SECRET`（`webhook.js:41`）、`TOKEN_ENCRYPTION_KEY`、`MIGRATION_SECRET`、`ALLOWED_ORIGIN`。
- **webhook 簽章只有一個全域 `LINE_CHANNEL_SECRET`**（`webhook.js:41`）。每個 LINE channel 的 secret 都不同，所以只有 secret 與它相同的那一個 OA 的 webhook 能通過驗簽，其他 OA 一律 401。見 gap-analysis P0-1。
- **`/token/register` 不建立 `bot:{id}:permissions`／`owner`**（`token.js:137-154`）；這兩筆只有 `migration/migrate.js:201-219` 會寫。見 gap-analysis P0-2。
- 加 D1：`wrangler.jsonc` 的 prod 與 `env.dev` 各寫一份 `d1_databases`（dev 不繼承頂層）；需要 SQL migration 目錄（目前沒有）；`tests/helpers/mock_kv.mjs` 只模擬 KV，需要新的 D1 測試 helper；`test_wrangler_config.mjs` 要補 dev／prod 隔離斷言；部署用的 Cloudflare token 需有 D1 權限（無法由 repo 確認）。

## 8. 測試

`npm test` = `node --test tests/unit/test_*.mjs`（2 秒內）；`test_index_bridge_routing.mjs` 用 module hook 替換 `__STATIC_CONTENT_MANIFEST`，可直接測 `worker.fetch`。
沒有專屬測試的 handler：`bot`、`flow`（只有遠端腳本）、`push_message`；只被 `test_handler_dual_write` 間接涵蓋的：`flex`、`image_msg`、`imagemap`、`keyword_reply`、`profile`、`quick_reply`、`segmented_richmenu`、`tag`、`tier`；`webhook` 只有一個檔案引用。
CI：`ci.yml`（PR 與 push main：`npm test`＋eslint）；`deploy.yml`（push main：測試、eslint、`deploy:check`、部署、兩個 smoke test）。

## 9. Import 邊界工具

目前沒有。`eslint.config.js` 沒有 `no-restricted-imports`。可擴充：兩個 flat-config block（LM core 不得 import `bridge/**`；`bridge/**` 只能 import `lm_service.js` 與明確放行的共用模組；`index.js` 為 composition root 放行），CI 已跑 eslint，不必改 workflow。

## 10. 搬到 `worker_src/bridge/` 的影響面

要搬：`handler/systems.js`、`handler/bridge_messages.js`、`middleware/bridge_auth.js`、`lib/quota.js`、`auth_routes.js` 的 `isBridgeServiceRoute`。
共用不搬：`lib/line_api.js`、`lib/crypto_util.js`、`rate_limiter.js` 的 `bridgeRateLimit`、`kv_schema.js` 的 bridge 段。
需同步改 import：`index.js`（`:7,33-34,117-119,180-182`）、`test_bridge_auth`、`test_bridge_messages`、`test_systems_handler`、`test_quota`、`test_bridge_routes`、`test_auth_channel`、`test_bridge_rate_limit`、`scripts/pre_deploy_check.mjs:63`、`docs/ARCHITECTURE_PLATFORM.md` 的檔案路徑表。
