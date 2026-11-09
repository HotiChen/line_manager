# 函式審查、未完成功能、路線圖與 LINE@ 遷移方案

2026-11-10。所有結論都對程式碼驗證過，不採用 TODO.md 自己的勾選狀態
（那份從 2026-06 之後沒更新，與現狀已經不符）。

本次工作起點：main 已含 `babcf07`（DOMPurify fail-closed）、`d905b86`
（dev/prod KV 分離），130 測試綠、CI 綠。

---

## 一、最重要的發現：資料模型分岔成兩套，而且卡在中間

這不是某個 function 的問題，是整個系統的狀態，所以放第一位。

**舊模型（16 個 handler）** —— 所有 KV key 以「呼叫者本人的 LINE userId」命名：

```
member_list_${userId}        keyword_reply_list_${userId}
tag_list_${userId}           flex_list_${userId}
current_token_${userId}      access_tokens_${userId}
```

**新模型（`team.js` + `bot.js`）** —— 以 botId 命名、帶角色：

```
BotKeys.permissions(botId)   → { users: [{ userId, role }] }
UserKeys.bots(userId)        → { bots: [...], currentBotId }
```

只有 `team.js` 一個 handler 引用 `withPermission`。其餘 16 個完全沒有
role 或 permission 字樣（實測：team.js 53 處，其他全部 0 處）。

`bot.js:46` 的註解自己寫了實話：

> 這邊比較複雜，因為舊系統用 project name，新系統用 botId
> 暫時先不更新舊系統，假設前端會全面改用新 API

前端沒有全面改用新 API，所以遷移停在半途。

### 後果：團隊協作功能實際上不能用

邀請同事 → 同事用自己的 LINE 帳號登入 → 打 `/keyword/list` →
讀到 `keyword_reply_list_<同事自己的 userId>` → 空的。

同事看不到也管不到老闆的 bot。能動的只有 `/team/*` 自己那幾個端點
（成員列表、邀請），也就是「管理團隊成員」這件事本身。

這同時是 `docs/SAAS_INTEGRATED_ANALYSIS_2026-06-11.md` 想走的多租戶
SaaS 方向的硬前提 —— 不先收斂成一套，後面每加一個功能都要寫兩遍。

### 建議：統一到 botId，而不是補 userId

1. `kv_schema.js` 補 `BotKeys.*` 的完整 key 清單（member/keyword/tag/flex/richmenu…）
2. 寫一次性 migration：`<prefix>_${userId}` → `<prefix>_${botId}`，
   botId 取該 user 既有的第一個 bot（已有 `migration/migrate.js` 可擴充）
3. handler 簽章由 `(request, env, userId, …)` 改為
   `(request, env, botId, role, …)`，比照 team.js 用 `withPermission` 包裝
4. `index.js` 在認證後解析 `currentBotId` 並檢查 role，再分派

這是 3-5 天的工作，而且必須一次做完 —— 做一半會變成三套模型。

---

## 二、函式層級的具體建議

### 2.1 死碼：確認零引用，建議刪除

| 位置 | 規模 | 說明 |
|---|---|---|
| `helper/autotag-ui.js` | 265 行、8 個 export | **完全沒有任何檔案 import 它**。自動標籤 UI 整個模組寫完但從未接上頁面 |
| `lib/line_api.js::broadcastMessage` | 1 函式 | 零引用。群發功能的後端半成品 |
| `helper/security.js::safeHTML` | — | 保留（`setInnerHTML` 內部使用），但外部零直接呼叫，屬正常 |

`autotag-ui.js` 是本次審查找到最大的單一未完成功能：265 行可用程式碼
擱在那裡。要嘛接上 keyword/member 頁面，要嘛刪掉 —— 留著是假資產。

### 2.2 只有測試在用，正式程式碼沒接

| 函式 | 狀況 |
|---|---|
| `middleware/auth.js::withAuth` | 有實作、有測試，`index.js` 沒用它（手寫認證流程） |
| `middleware/permission.js::checkPermission` | 同上，只有 team.js 透過 `withPermission` 間接用到 |
| `lib/tag_system.js::getTagStats` / `batchAddTag` / `getEntitiesByTag` | 標籤系統的進階能力都寫好了，沒有端點暴露出去 |

`tag_system.js` 這三個特別可惜 —— CRM 要的「依標籤撈人、批次貼標、標籤
統計」後端現成，只差 3 個端點加前端。這是性價比最高的一塊。

### 2.3 god file：改任何東西都要先讀幾千行

```
js/flow_designer.js   5,357 行
js/richmenu.js        1,934 行
js/flex_builder.js    1,725 行
helper/message.helper.js 1,046 行
```

`flow_designer.js` 內有唯一一個真 TODO（`:3302` 連接 keyword 回覆訊息）。
建議拆法：canvas-render / node-edit / serialize / persist 四塊，每拆一塊補測試。

### 2.4 測試覆蓋的真實分布

17 個 handler 裡只有 3 個有測試：

```
有測試    member、token、webhook（簽章）
沒測試    bot flex flow image_msg imagemap keyword_reply profile
          push_message quick_reply richmenu segmented_richmenu
          tag team tier  ← 14 個
```

`team.js`（13.5K，唯一有權限邏輯的）和 `richmenu.js`（12.9K，最大的）
零覆蓋，是最該補的兩個。`tests/helpers/mock_kv.mjs` 已經有了，照 member
那份的寫法套即可。

### 2.5 rate limiter 的 fail-open 是刻意的，但要知道代價

`middleware/rate_limiter.js:64-67` KV 失敗時 `allowed: true`。註解寫了
理由（基礎設施故障不該擋正常流量），這個權衡合理。代價是 KV 一掛，
rate limiting 整個消失。建議至少加計數器，讓 fail-open 的次數可觀測。

### 2.6 前端 console 殘留

`js/` 206 處、`helper/` 17 處、`worker_src/` 25 處。CI 的 lint 範圍目前是
`worker_src tests`，所以前端完全沒擋。建議把 `helper/` 先納入範圍（它只有
3 個既有 `no-empty` 要修），`js/` 因為債太多，用 `no-console` warning 先觀測。

---

## 三、未完成功能清單（對程式碼驗證後）

TODO.md 有 99 個未勾選項目、22 個主題。實際狀態：

### 已經做完但 TODO.md 還標未完成

| TODO 項目 | 實際狀態 |
|---|---|
| 1. XSS 防護強化 | `setInnerHTML` 103 個呼叫點 + DOMPurify，今天補上 fail-closed。**已完成** |
| 4. 移除 Debug 代碼 | 後端做了，前端 206 處還在。**部分** |
| 6. API 客戶端統一 | 今天統一到 `state.getAuthHeaders()`。**已完成** |
| 12. API 安全加固 | fail-closed、Channel 驗證、`/api/*` 認證都做了。**已完成** |

### 真正未完成，依性價比排序

| # | 功能 | 缺什麼 | 估時 |
|---|---|---|---|
| 1 | **標籤進階操作** | 後端 `tag_system.js` 三個函式現成，缺 3 個端點 + 前端 | 0.5-1 天 |
| 2 | **自動標籤 UI** | `autotag-ui.js` 265 行現成，缺接線 | 0.5-1 天 |
| 3 | **Analytics 儀表板**（TODO 16） | `message_stats.js` 有計數，缺聚合端點與圖表 | 2-3 天 |
| 4 | **資料模型統一到 botId** | 見第一節 | 3-5 天 |
| 5 | **Narrowcast 分眾推播**（TODO 20） | 需先有 Audience；LINE API 現成 | 2-3 天 |
| 6 | **Audience 受眾管理**（TODO 21） | 全新 | 2-3 天 |
| 7 | **Coupon 優惠券**（TODO 18） | 全新，需 LIFF 頁面 | 3-5 天 |
| 8 | **Template / Sticker 訊息**（TODO 19、22） | `line_client.js` 加 case 即可 | 各 0.5 天 |
| 9 | **Flow Designer 收尾**（TODO 14） | 拆檔 + `:3302` 的 TODO | 5+ 天 |

前兩項是「後端已經寫好、只差接線」，應該先做 —— 一天內能讓 CRM 的
標籤能力從「有後端沒入口」變成可用。

---

## 四、未來功能規劃

### 近期（1-2 週）：把現成的能力變成可用

1. 標籤進階操作 + 自動標籤 UI（第三節 #1、#2）
2. `team.js` 與 `richmenu.js` 補測試 —— 動資料模型之前要有安全網
3. Template / Sticker 訊息（兩個半天的小勝）

### 中期（3-6 週）：資料模型與分析

4. 資料模型統一到 botId（第一節）—— 這是分水嶺，之後才能談多租戶
5. Analytics 儀表板
6. Audience + Narrowcast（分眾推播是 CRM 的變現點）

### 長期（2 個月以上）：產品化

7. Coupon 系統（需 LIFF 頁面與核銷流程）
8. Flow Designer 拆檔重構
9. token 加密存放（AES-GCM + `wrangler secret`）
10. 引入 Vite 做 bundle + CSP header

### 不建議現在做

- 全站遷到 Vue/Svelte —— 26,000 行原生 JS 重寫，投報率太低。真要改，
  只把 flow_designer 那一頁單獨遷移
- `TODO.md`（28KB）+ `ISSUES.md`（13.7KB）合併成一份，或改用 GitHub Issues。
  兩份文件已經互相矛盾，維護成本大於價值

---

## 五、LINE@ 既有資料怎麼遷進來

先講結論，因為這題的答案跟多數人的預期不同：

> **LINE 官方不讓你匯出好友名單和標籤。**
> LINE Official Account Manager 唯一能下載成 CSV 的是「聊天紀錄」。
> 標籤、備註、負責人都是人工維護的欄位，不在匯出範圍內。

所以遷移不是「匯出再匯入」，而是**重建 + 逐步累積**。

### 5.1 三種資料，三種處境

| 資料 | 官方出口 | 做法 |
|---|---|---|
| **好友 userId** | `GET /v2/bot/followers/ids` | **僅限認證帳號（藍盾）與進階帳號（綠盾）**。一般帳號（無盾）拿不到，只能從今天起靠 follow 事件累積 |
| **好友 profile**（暱稱、頭像） | `GET /v2/bot/profile/{userId}` | 有了 userId 就能逐一取得。可直接寫進 `member_profile_${id}` |
| **標籤 / 備註** | 無 | 官方零出口。只能人工重建，或用第三方工具 |

### 5.2 如果是認證／進階帳號（藍盾或綠盾）

可以一次性全量遷入。寫一個 migration 端點：

```
1. GET /v2/bot/followers/ids?limit=1000     ← 分頁，回應帶 next 續傳 token
   注意：單頁回傳數量可能少於 limit 但仍帶 next，不可用「數量不足」判斷結束
2. 對每個 userId 打 /v2/bot/profile/{userId}
3. 寫入 member_profile_${botId}_${lineUserId} 與 member_list_${botId}
```

續傳 token 的行為要照 LINE 文件處理 —— `next` 只在「還有未回傳的 userId」
時出現，而單頁數量不保證等於 `limit`。用數量判斷會漏人。

建議掛在現有的 `migration/migrate.js`（已有 `MIGRATION_SECRET` 保護，
而且今天補上了未設定時回 503 的 fail-closed）。

### 5.3 如果是一般帳號（無盾）

拿不到既有好友名單。這不是程式問題，是 LINE 的政策。可行路徑：

**路徑 A：等待累積（零成本）**
`handleFollowEvent` 已經會呼叫 `recordMemberInteraction` 寫入會員資料，
所以**從 webhook 接上的那天起**，新加入的好友自動進 CRM。既有好友會在
他們下次互動（傳訊息、點 postback）時被 `handleMessageEvent` 補進來。
實測：`event_handler.js:307-313`。

**路徑 B：主動觸發互動（建議搭配 A）**
用 LINE 的群發訊息（broadcast）發一則需要互動的訊息 —— 例如「點我領取
會員優惠」的 Quick Reply 或 postback 按鈕。點了的人就被收進 CRM。
搭配 `/profile/register` 做會員註冊 LIFF 頁，一次拿到更多欄位。

注意 `lib/line_api.js::broadcastMessage` 已經寫好但零引用（見 2.1）——
這個情境正好是它的用途，建議接上而不是刪掉。

**路徑 C：升級成認證帳號**
申請藍盾（免費，需審核），通過後就能用 5.2 的全量遷入。如果既有好友
數量大，這是唯一能一次拿完的方法。

### 5.4 標籤怎麼重建

官方沒有出口，三個選項：

1. **人工比對**：從 OA Manager 匯出聊天紀錄 CSV（唯一能匯出的東西），
   用它認出重要客戶，在新系統手動貼標。適合好友數少的情況。
2. **第三方工具**：Lステップ、CScloud、Liny（エルメ）等日系工具支援
   好友 CSV 匯出含標籤。要先確認目前的匯出範圍與費用，而且這些工具
   本身要先接上你的 OA 一段時間才有資料。
3. **非官方 API**：有開發者用 OA 的內部聊天列表 API 取得每個對話的
   tag id。LINE 不支援、隨時可能失效，且可能違反服務條款。**不建議**。

比較務實的做法是接受標籤重建，但**把重建成本降到最低**：先做第三節
的 #1、#2（標籤進階操作 + 自動標籤 UI），讓批次貼標和自動貼標可用，
人工重建就不會是一筆一筆點。

### 5.5 建議的遷移順序

```
1. 確認帳號類型（OA Manager 看是否有藍盾／綠盾）
   ├─ 有 → 寫 followers/ids 全量遷入（5.2），1 天
   └─ 無 → 接 webhook 開始累積（已可用）+ 接上 broadcastMessage 主動觸發
2. 做標籤進階操作 + 自動標籤 UI（第三節 #1 #2），1-2 天
3. 用聊天紀錄 CSV 認出重要客戶，批次貼標
4. 之後靠自動標籤規則持續累積，不再人工
```

---

## 附：本次已完成並推上 main

| commit | 內容 |
|---|---|
| `9a517b3` | 合併 6 月的專案審查分支（fail-closed、CI、刪 3 萬行重複碼） |
| `89755a5` | LIFF Channel 驗證、`/api/*` 認證、不信任自報 userId |
| `babcf07` | DOMPurify 缺席時逸出而非原值放行 |
| `d905b86` | dev/prod KV namespace 分離 + 設定不變量測試 |

130 測試綠、`eslint worker_src tests --quiet` 綠、CI 綠。

## 來源

LINE Messaging API 的 followers/ids 限制與續傳行為：
- https://developers.line.biz/en/reference/messaging-api/
- https://www.jsdocs.io/package/@line/bot-sdk

LINE OA Manager 的匯出範圍（只有聊天紀錄）與第三方工具：
- https://line-sm.com/blog/liny-friends-info/
- https://line-sm.com/blog/lineofficial_friends_list/
- https://markecats.co.jp/column/250418/
