# botId 統一：操作手冊

把 KV 從 `<domain>_${userId}`（綁呼叫者本人）收斂到 `bot:${botId}:<resource>`
（綁官方帳號）。

為什麼要做：同一個人持有兩個官方帳號時，兩邊的資料混在一起；邀請來的同事
登入後看到的是他自己的空命名空間，而不是那個 bot 的資料。

架構背景見 `ARCHITECTURE_PLATFORM.md` 第六、十三節。這份只講怎麼跑。

---

## 零、現在的狀態

| 元件 | 狀態 |
|---|---|
| `lib/kv_schema.js` — 新舊 key 的唯一產生處 | ✅ |
| `lib/bot_context.js` — userId ↔ botId 橋接 | ✅ |
| `lib/bot_store.js` — 雙讀雙寫存取層 | ✅ |
| `migration/migrate.js` — 可重入回填 + 回滾 | ✅ |
| handler 切換 | ✅ 16 / 17 個資源（剩 1 個是死資料） |
| 回填 prod | ⬜ 還沒跑 |
| 停雙寫、刪舊 key | ⬜ |

切換進度的權威來源是 `lib/bot_store.js` 的 `RESOURCES` 表，每個資源一個
`switched` 欄位。`GET /admin/migrate?mode=status` 會把它列出來。

**已切換**（全部走 `lib/bot_store.js`）：`keywords`、`keywordStats`、
`keyword`、`flexList`、`images`、`imagemaps`、`quickReplies`、`welcome`、
`tierConfig`、`segmentedRichMenuRules`、`richMenuMeta`、`members`、`member`、
`memberLog`、`tags`、`tagEntities`、`messageStats`、`message`，
加上 user 命名空間的 `profile`。

**刻意不切換**：`flex`（單筆 `flex_${userId}_${id}`）。那是比 `flexList`
更早的格式，目前沒有任何程式讀寫它，回填一批沒有人會讀的死資料沒有意義。
確認可以刪之後把它從 `RESOURCES` 移除即可。

**仍然以 userId 為命名空間、且是刻意的**：

- `access_tokens_${userId}` / `current_token_${userId}`（`lib/token_store.js`）
  —— 憑證屬於「註冊它的人」，而且已經有自己的加密層。
  `BotKeys.credential(botId)` 已經在 schema 裡保留了位置，但搬它要連同
  加密與 webhook 的 destination 反查一起處理，是獨立的一件事。
- `rl_${userId}_${window}`（`middleware/rate_limiter.js`）—— 限流限的是一個人
  的呼叫速率，不是一個 bot 的。架構文件第十節有系統主體限流的設計，
  那是接橋接 API 時才需要。
- `flow_${userId}_${botId}_*`（`handler/flow.js`）—— 這組 key 本來就有 botId
  維度，只是順序與新 schema 不同。沒有混淆風險，低優先。

---

## 一、切換一個 handler（重複到全部切完）

一次一個資源，各自附測試。順序由易到難：沒有 id 的單一 key 最簡單，
會員與標籤最難（它們散在 `lib/tag_system.js`、`lib/tier_system.js`、
`lib/event_handler.js` 裡，而且 webhook 路徑上沒有登入的 userId）。

1. handler 裡把 `env.KV_LINE_STORAGE.get(\`xxx_${userId}\`)` 換成

   ```js
   const store = await openBotStore(env, userId);
   const value = await store.getOr('resourceName', []);
   ```

2. 寫入換成 `await store.put('resourceName', value)`，刪除換成 `store.del(...)`。
3. 在 `RESOURCES` 把該資源標成 `switched: true`。
4. 在 `tests/unit/test_handler_dual_write.mjs` 加三個測試：
   只有舊 key 時讀得到、新 key 優先、寫入後兩邊都有。
   **第二個最重要** —— 它是「handler 還在偷讀舊 key」唯一會被抓到的地方。
5. `npm test` 全綠才算切換完成。

### webhook 路徑：botId 才是權威（已處理）

這是整個切換裡最容易安靜出錯的地方，值得記住為什麼。

後台路徑的 botId 來自 `resolveBotId(userId)`，也就是「這個人在介面上選的
bot」。**webhook 不可以用它。** 事件屬於 LINE 的 `destination` 指定的那個
官方帳號，與 owner 當下在後台看哪一個完全無關。一個持有兩個帳號的 owner，
A 帳號收到的訊息會被寫進 B 的命名空間 —— 不丟錯、沒有 log，只是會員跑到
隔壁去，而且事後分不回來。

所以：

- `webhook.js` 把 `destination` 傳給全部四種事件（message / follow /
  unfollow / postback），不只 follow。
- `event_handler.js` 的每個處理器都收 `botId`，並用
  `openBotStoreFor(env, userId, botId)` —— 兩個都已知，不在那一層再猜一次。
- 只知道 botId 的呼叫端用 `openBotStoreForBot(env, botId)`，它會用
  `resolveOwner` 反查 owner 以取得舊命名空間。反查不到時只走新命名空間
  （在回填完成前等於讀不到舊資料），所以能給 userId 就給。

`tests/unit/test_botid_namespace.mjs` 守這件事，每個測試都刻意把
`currentBotId` 設成「錯的那個」。

### queue 的生產端還不存在

`queue/tag_consumer.js` 從 `message.body` 讀 `botId`。目前沒有任何地方
把任務丟進那個 queue（`wrangler.jsonc` 的綁定也還是註解掉的）。等要啟用
時，生產端**必須**把 destination 放進 body —— 不可以在消費端用
`resolveBotId(userId)` 回推，因為任務可能在 owner 切到別的帳號之後才被消化。

---

## 二、回填 prod

端點是 `GET /admin/migrate`，需要 `MIGRATION_SECRET`（`wrangler secret put`）。
未設定時端點回 503 而不是放行。

### 先看現況

```bash
curl -s "https://<worker>/admin/migrate?key=$SECRET&mode=status" | jq
```

回傳使用者數、是否有未完成的游標、以及已/未切換的資源清單。

### 單一使用者試跑

先挑一個自己的登入試，看 log 再決定要不要整批跑。

```bash
curl -s "https://<worker>/admin/migrate?key=$SECRET&userId=U<你的id>" | jq .logs
```

### 整批跑

一次處理 10 個使用者（避免撞上 Worker 的 CPU 上限），重複呼叫到
`done: true`。游標存在 KV 的 `migration:botid:cursor`，中斷後重跑會從
上次的位置繼續。

```bash
curl -s "https://<worker>/admin/migrate?key=$SECRET&mode=all" | jq '{processed, done}'
```

重跑是安全的：單一使用者的回填是冪等的，重做沒有代價。

### 從頭重跑

```bash
curl -s "https://<worker>/admin/migrate?key=$SECRET&mode=all&restart=1" | jq
```

### 回滾一個使用者

刪掉 `bot:${botId}:*` 與 `user:${userId}:*` 的全部 key。**舊 key 不會被動**，
所以回滾之後系統仍然完全可用，只是雙讀會走回退路徑。

```bash
curl -s "https://<worker>/admin/migrate?key=$SECRET&userId=U<id>&mode=rollback" | jq .logs
```

---

## 三、不要做的事

**不要用 `force=1`**，除非你很確定要蓋掉使用者在回填之後做的修改。
預設行為是「新 key 已經有值就跳過」，那不是保守，那是正確的 —— 雙寫已經
上線，新 key 裡可能是比舊 key 更新的值。

**不要在 handler 切換之前回填它的資源。** 回填腳本自己會擋（只處理
`switched: true`），但別繞過它手動搬。提前回填留下的舊快照會在該 handler
切換的那一刻立刻生效，使用者的資料會跳回回填當時的版本。

**不要刪舊 key**，直到 `bot_store` 的 `legacy_fallback` log 連續數天歸零。
那個 log 是回填是否真的覆蓋到全部資料的唯一訊號。

### 如果 dev 跑過舊版 migration

2026-11 之前的 `migrate.js` 會把 `members`、`tags`、`tierConfig` 等還沒切換的
資源也寫進 bot 命名空間。那些是**陳舊快照**，等對應的 handler 切換時會立刻
生效並蓋掉正確的資料。

處理方式：對受影響的使用者跑一次 `mode=rollback`（它會清掉整個 bot 命名空間，
舊 key 不受影響），再跑一次新版回填。

---

## 四、完成的定義

1. `RESOURCES` 裡每個資源都 `switched: true`
2. `mode=status` 的 `pendingResources` 是空的
3. `mode=all` 回 `done: true`，且游標已被清掉
4. `legacy_fallback` log 連續數天為 0
5. 備份 KV
6. 停掉 `bot_store` 的雙寫（`put` / `del` 只寫新 key）
7. 刪掉舊 key

第 6 步到第 7 步之間要一次做完 —— 那是整個流程唯一不可中斷的一段。
