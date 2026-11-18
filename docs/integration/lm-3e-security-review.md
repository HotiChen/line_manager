# LM-3E Bridge 對抗式安全審查

- 日期：2026-11-18
- 對象：`/home/user/line_manager`，HEAD `fbf75f2`（含 `9c278ca` 同意頁 frame guard）
- 立場：攻擊者視角，唯讀審查。未修改 `worker_src/`、`tests/`、`js/`、`pages/`、`migrations/`；未連外部網路；未 commit。
- 結論先講：**沒有 Critical、沒有 High。** 有 3 個 Medium、12 個 Low、8 個 Info。Medium 的共同點是「濫用與耗損」而不是越權：金鑰型別、跨連結、SQL、授權碼單次使用這些硬邊界我都沒能打穿。

## 範圍

`worker_src/bridge/*`、`worker_src/lm_service.js`、`worker_src/index.js` 與 `lib/event_handler.js` 的 Bridge 掛鉤（綁定碼、follow／unfollow）、`middleware/rate_limiter.js`、`migrations/*.sql`、同意頁（`pages/link_authorize.html`、`js/link_authorize.js`、`helper/link_authorize_form.js`）、已連結產品後台（`pages/system_management.html`、`js/system_management.js`）、`docs/integration/*.md`（bridge-v1.yaml、lm-1b／2a／3a／3b-plan、ARCHITECTURE_PLATFORM.md）。另外讀了 `lib/line_api.js`、`lib/signature.js`、`handler/webhook.js`、`middleware/auth.js`、`lib/frame_guard.js`、`lib/utils.js`（CORS）、`utils/logger.js`，因為它們直接影響 Bridge 的行為。

## 方法

1. 逐檔讀程式（認證、授權、SQL、狀態機、回應與 log 內容）。
2. 在 scratchpad 寫拋棄式腳本，用 Miniflare 真 D1（同 `tests/helpers/mock_d1.mjs`）與記憶體 KV 驗證可驗證的主張。腳本不在 repo 內：
   - `/tmp/claude-0/-home-user-line-manager/243ead4c-fe85-5c5c-96a2-9bb7a9e05802/scratchpad/e1_url.mjs`：action.url 白名單與文字連結檢查模糊測試
   - `.../e3_frame.mjs`：用真的 `kv-asset-handler` 0.4.2 與 `frame_guard.js` 測 URL 變體
   - `.../e4_drills.mjs`：綁定碼並行、燒碼、限流並行、冪等 TTL、重授權搬移、授權碼並行
   - `.../e5_matrix.mjs`：金鑰型別混用與跨連結存取矩陣（經 `handleBridge` 端到端）與洩漏掃描
   - `.../e6_cors.mjs`、`e7_misc.mjs`、`e8_redos.mjs`
3. `npm test`：1745 項全過（審查前執行）。未跑 eslint。

## 未驗證（我做不到或沒做）

- **真實 LINE 行為**：Flex 內文字是否會被 LINE 客戶端自動轉成連結（影響 L-03 的實際嚴重度）、`X-Line-Retry-Key` 409 的完整語意、哪些情況會回 403（影響 L-05）、LINE 400 回應本文是否回顯欄位值、使用者端傳訊息的速率上限（影響 M-02 的猜碼速度）。
- **真實 D1**：只用 Miniflare 的 SQLite。`batch()` 的交易回滾、並行序列化是依文件與測試推論，沒在正式 D1 上跑。
- **真實 KV**：記憶體 mock 無法重現 KV 的最終一致性（跨邊緣節點／快取讀取延遲），所以 M-01、M-02 的限流弱點在真實環境只會更糟，不會更好。
- **Cloudflare 邊緣設定**：「Normalize incoming URLs」是否開啟（影響 L-01 哪些變體到得了 Worker）、WAF、rate limiting rules。
- **已部署設定與機密**：`BRIDGE_ENABLED`、`BRIDGE_ADMIN_SECRET` 的長度與熵、`WEBHOOK_GLOBAL_SECRET_DISABLED`、`ALLOWED_ORIGIN`、各 bot 是否已登記自己的 channel secret。
- **真實 LIFF 登入**與產品端（Image Picker 等）如何處理 `state`。
- GPU 破解速度（L-11）是依公開基準的估算，沒有實跑。
- 前端：只讀碼，沒開瀏覽器；沒測 XSS 以外的 DOM 行為。

---

## Medium

### M-01 單一連結可耗盡整個官方帳號的 LINE 月額度；唯一的節流器非原子且 fail-open

**處理狀態（2026-11-18）：已修（程式與測試完成，待部署並手動套用 migration 0004）。** D1 原子計數取代 KV 限流器、新增每連結每日預算與 `usage_high` 稽核；對照見 `lm-sec-plan.md` §6。「自動停用連結」未做（D3：先觀察）。

- 位置：`worker_src/bridge/notify.js:39-40, 341-369`、`worker_src/middleware/rate_limiter.js:272-307`、`worker_src/bridge/quota.js:92-123`
- 攻擊情境：產品（或持有連結金鑰的人）對自己名下的聯絡人持續送通知。限制只有每連結 60 則／分鐘、每（連結, ref）10 則／小時，沒有每連結或每月預算；額度檢查看的是整個 OA 的 LINE 剩餘量。產品只要有 ≥ 6 個已綁定 ref，就能穩定跑滿每分鐘 60 則；免費方案 200 則約 4 分鐘用完。額度是 OA 共用的：商家自己的群發、其他產品也一起被擋；付費方案則直接變成費用。
- 證據：讀碼；`e4_drills.mjs` 的 E 項——100 個並行 `checkRateLimit`（limit 10）全部 allowed（100/100）；沒有 KV binding 時 100/100；KV 丟錯時 allowed=true。這是 get→put 的 read-modify-write，並行與跨節點都不成立；真實 KV 還有快取與最終一致性，更弱。
- 影響：可用性與費用。不是資料外洩。
- 建議修法：
  1. 在 D1 做每連結（或每產品＋bot）的**月度／日度發送預算**，用單一 `UPDATE … SET n = n + 1 WHERE n < cap` 的原子語法，超過回 `QUOTA_EXCEEDED`；預算上限由 owner 在同意或後台設定，預設保守。
  2. 每連結 60/min 與每聯絡人 10/h 也改用 D1 原子計數（或 Durable Object），KV 限流器留給低風險用途。
  3. 異常用量（例如 1 小時內用掉 OA 月額度 >20%）寫稽核並可選擇自動停用連結。
- 要不要加測試：要。「並行 N 個送出，實際送出不得超過預算」「預算耗盡不打 LINE」。

### M-02 綁定碼只有約 40 bit，嘗試限流以 LINE userId 為鍵且可並行繞過

**處理狀態（2026-11-18）：已修（程式與測試完成，待部署並手動套用 migration 0004）。** 12 碼／48 小時、D1 原子嘗試計數與每 bot 暫停、覆蓋預設拒絕（`allow_rebind`）；對照見 `lm-sec-plan.md` §6。

- 位置：`worker_src/bridge/binding.js:23, 29, 32-37, 69`、`worker_src/bridge/db.js:599-627, 636-657`
- 攻擊情境：攻擊者想把自己的 LINE 帳號綁到別人的 `external_contact_ref`（之後該客戶的通知會寄到攻擊者）。碼是 `LM-` + 8 碼 Crockford base32 = 2^40 ≈ 1.1×10^12，7 天有效，單次使用。猜測成功率 ≈ （有效未用碼數）/ 2^40，且命中的是 bot 內**任何**一組未用碼，不能指定目標。每連結最多 1000 組有效碼，但沒有每 bot 的上限，多連結會累加。限流是 `bindattempt.{botId}.{lineUserId}` 每分鐘 10 次：換 LINE 帳號就換桶；同一帳號並行送也繞得過（見 M-01 的並行實測）；KV 缺或錯時 fail-open。
- 量化：1000 組有效碼時，每 100 萬次猜測命中機率約 0.09%（1e6×1e3/1.1e12）。實際速度受 LINE 使用者端送訊息速率限制（**未驗證**）。所以是「低機率、高衝擊」：命中的後果是個資（訂單／通知）送給錯的人，而且客戶端毫無警示（見下）。
- 安靜覆蓋：同 (連結, ref) 新碼被消耗時直接覆蓋綁定，原綁定者不會收到任何通知（`upsertContactBinding`，`db.js:663-679`；`e4_drills.mjs` D 項確認）。
- 證據：讀碼＋`e4_drills.mjs`（B：30 個並行消耗同一碼只有 1 個贏，這部分沒問題；C：跨 bot 不可用；E：限流並行繞過）。
- 建議修法：
  1. 碼加長到 ≥ 64 bit（例如 12 碼 base32 = 60 bit，分組顯示 `LM-ABCD-EFGH-JKMN`），並把 TTL 由 7 天縮短（預設 24–48 小時，可由產品指定上限）。
  2. 嘗試限流改成 D1 原子計數，維度加上 bot（例如每 bot 每分鐘全域失敗次數），失敗次數過高時對該 bot 暫停綁定並寫稽核。
  3. 覆蓋已綁定的 ref 時：預設拒絕，或在新綁定時對舊 LINE 使用者推一則「你的綁定已被更換」（需產品明示 `rebind=true` 才允許覆蓋）。
- 要不要加測試：要。「同一 bot 下每分鐘失敗嘗試超過門檻後，有效碼也暫時不可用」「覆蓋既有綁定需明示」。

### M-03 同意頁不顯示「授權碼會送到哪個網址」，規格也沒要求產品驗證 `state`（授權釣魚／帳號連結 CSRF）

**處理狀態（2026-11-18）：已修（程式與測試完成）。** 同意頁顯示已驗證的回調主機名稱與授權效果，`bridge-v1.yaml` 加上 `state` 的 MUST 並由契約測試檢查；對照見 `lm-sec-plan.md` §6。

- 位置：`pages/link_authorize.html:187-229`（只顯示產品名稱、OA 名稱、權限）、`worker_src/bridge/links.js:284-327`、`docs/integration/bridge-v1.yaml:93-103`
- 攻擊情境：攻擊者是多租戶產品（例如 Image Picker）的一個普通租戶。他在自己的租戶頁面按「連結 LINE 官方帳號」，取得帶有他自己的 `state` 的授權網址，傳給受害商家的 OA owner。owner 看到熟悉的產品名稱與自己的 OA，按同意，授權碼導回產品 callback，附的是攻擊者的 `state`；產品若沒有把 `state` 綁定到發起者的 session，就會把受害者的 OA 連結掛到攻擊者的租戶上。結果：攻擊者租戶取得該 OA 的 `contacts:bind` 與 `messages:send`，可以發綁定碼、以商家的官方帳號名義對綁定者發通知、燒商家額度。
- 這不是伺服端能完全解決的（`state` 的驗證在產品端），但伺服端有兩個低成本緩解沒做：同意頁沒讓使用者看到回調網址的主機名稱；bridge-v1.yaml 沒有要求產品必須驗證 `state`、必須把 `state` 綁定 session。PKCE 在這裡不解決問題（產品是 confidential client，持有密鑰），所以我不把「沒有 PKCE」列為缺口。
- 證據：讀碼與 HTML；`validateRedirectTarget`（`helper/link_authorize_form.js:441-450`）只驗證導向一致，不是顯示。
- 建議修法：同意頁顯示已驗證的 `redirect_uri` 主機名稱（textContent，非連結）與「授權後你的客戶可綁定並收到來自 {OA 名} 的通知」；bridge-v1.yaml 的 `/link/authorize` 加上 MUST：`state` 必須是不可預測、綁定發起者 session、回調時驗證；範例程式碼示範。可選：授權頁顯示「這是由 {產品名}（{host}）發起」＋最近 N 分鐘內是否有人從不同 IP 發起（過度設計，先做前兩項）。
- 要不要加測試：要（UI 顯示 host；契約文件測試檢查 MUST 敘述存在）。

---

## Low

### L-01 frame guard 以精確路徑比對，URL 變體可繞過（已知項目的修補不完整）

- 已知：同意頁原本沒有 X-Frame-Options，已於 `9c278ca` 以 `lib/frame_guard.js` 補上。本項是該修補的繞過。
- 位置：`worker_src/index.js:98-103`、`worker_src/lib/frame_guard.js:9`
- 攻擊情境：`withFrameProtection(response, pathname)` 用 `pathname === "/pages/link_authorize.html"` 精確比對，但 `getAssetFromKV` 會對路徑做 `decodeURIComponent` 再查 manifest。所以下列請求都會服務同意頁，卻沒有 `X-Frame-Options`／`frame-ancestors`。
- 證據（`e3_frame.mjs`，用真的 kv-asset-handler 0.4.2）：
  - `/lm/pages/link_authorize.html` → `X-Frame-Options: DENY`（正常）
  - `/lm/pages%2Flink_authorize.html` → 頁面內容照出，無 XFO
  - `/lm/pages/%6Cink_authorize.html` → 頁面內容照出，無 XFO
  - `/lm/pages/link_authorize%2ehtml` → 頁面內容照出，無 XFO
  - `/lm//pages/link_authorize.html` → 頁面內容照出，無 XFO
- 影響低的原因：頁面內仍有 `top !== self` 的行內與模組檢查，framed 時卡片被移除、按鈕預設 disabled；要成功點擊劫持需要先讓這個 JS 守衛失效，我沒找到方法。另外 `%2F` 變體會讓相對路徑的 `../js/…` 解析到 mount 之外，頁面本身就壞掉；`%6C`、`%2e` 變體頁面可正常運作。Cloudflare 的 URL 正規化（若開啟）會先把 `%6C`、`%2e` 解碼，但不會解 `%2F`——**未驗證**部署設定。
- 建議修法：不要比對請求路徑，比對「實際服務的資產」。例如對所有 `.html` 靜態回應預設加 `frame-ancestors 'none'`（LIFF 頁面若需被 LINE 內嵌，逐頁豁免），或在 `index.js` 先把路徑正規化（`decodeURIComponent`、合併 `//`、移除 `.`／`..`）再同時用於查資產與守衛，或對含 `%` 或 `//` 的路徑直接 404。
- 要不要加測試：要。把上面五個變體寫進 `test_frame_guard.mjs` 風格的整合測試（可用 kv-asset-handler 的假 manifest，如 `e3_frame.mjs`）。

### L-02 「先消耗、後寫入」的兩段式流程：失敗或競賽時碼被燒掉、綁定遺失

- 位置：`worker_src/bridge/binding.js:72-75`、`worker_src/bridge/links.js:374-385`、`worker_src/bridge/db.js:636-679`
- 情境與證據：
  1. 綁定：`consumeBindCode`（一個 batch）成功後才 `upsertContactBinding`。D1 在兩者之間失敗 → 碼已 `used_at`、沒有綁定、客戶沒收到回覆，重送同一碼也無效（`e4_drills.mjs` A 項實測：handled=false、retry handled=false、used_at 已設、contacts=0）。恢復要產品重新發碼。
  2. 授權碼：`consumeAuthCode` 之後才 `createLinkWithKey`；後者失敗或 `scopes.length === 0`（`links.js:380-381`）時碼已燒，產品得到 503／INVALID_CODE，要使用者重新授權。
  3. 重授權競賽（讀碼推論，沒做時序測試）：`consumeBindCode` 回傳舊連結 L1 後、`upsert` 之前若剛好發生重授權（`createLinkWithKey` 把 L1 的 contacts 搬到 L2 並撤銷 L1），`upsert` 會把綁定寫到已撤銷的 L1，客戶看到「已完成綁定」，產品看到的卻是未綁定；這筆資料之後也無人清理。
- 影響：可用性與狀態不一致，無越權。視窗很小。
- 建議修法：把「消耗＋寫綁定」併成一個 `db.batch`（`UPDATE bind_codes … ; INSERT … SELECT … FROM bind_codes JOIN links … ON CONFLICT DO UPDATE`），讓寫入的 `link_id` 就是同一交易裡查到的 active 連結；授權碼同理，把 `createLinkWithKey` 併進消耗的 batch，或失敗時把 `used_at` 還原。
- 要不要加測試：要（D1 在第二步失敗後碼仍可重用；重授權與消耗交錯後綁定落在 active 連結）。

### L-03 「內文不得含連結」只擋 `http://`／`https://` 子字串

- 位置：`worker_src/bridge/notify.js:55, 106-119`
- 證據（`e1_url.mjs`）：下列字串通過 title／body／label 驗證：`visit evil.com/login`、`www.evil.com`、`hxxps://evil.com`、`ht​tps://evil.com`（含 U+200B）、`https：//evil.com`（全形冒號）、`ｈｔｔｐｓ：／／evil.com`（全形）、`line://ti/p/@evil`、`tel:+886…`、含 U+202E（RLO）的字串，以及只有 U+200B 的 title（`trim()` 不會去掉它，所以通過「不可空白」檢查）。`HTTP://evil.com` 正確被擋。
- 影響：能否變成可點的連結取決於 LINE 客戶端是否自動連結 Flex `text`（**未驗證**）。即使不能點，產品能送出「請到 evil.com 登入」這種純文字釣魚；白名單防的是按鈕，擋不了文字內容。這是產品信任問題，不是越權。
- 建議修法：把 title／body／label 的判斷改成「正規化後（NFKC、移除 `\p{Cf}`、小寫）不含 `://`、`www.`、`<label>.<tld>` 形的裸網域」；拒絕 bidi 控制字元（U+202A–202E、U+2066–2069）與 `\p{Cf}`；blank 檢查用去除 `\p{Cf}` 之後的結果。要接受「裸網域可能是誤傷」的取捨（例如 `Dr.Smith`），或只在 `action` 缺席時才放寬。
- 要不要加測試：要（上列字串逐一斷言）。

### L-04 `url_domains` 接受公共後綴，且子網域一律放行

- 位置：`worker_src/bridge/links.js:57, 181-188`、`worker_src/bridge/notify.js:97-103`
- 證據（`e7_misc.mjs`）：營運密鑰登記 `["github.io"]`、`["pages.dev"]`、`["co.uk"]`、`["com.tw"]`、`["workers.dev"]` 都回 201。`checkActionUrl` 再讓它們的所有子網域通過（`e1_url.mjs` 確認子網域、`PICKER.EXAMPLE.COM.`、`%2E`、`。`、全形字母都正確正規化成同一主機；IDN／punycode、userinfo、反斜線、`#`／`?` 偽裝、IP、非 443 埠、非 https 都被擋，沒有繞過）。
- 影響：只有持有營運密鑰的人能登記，所以是「營運失誤」風險：一旦登記了公共後綴，任何人在該後綴下的子網域都能當按鈕目標，白名單失效。另外，白名單網域上的開放式轉址（`/redirect?to=`）仍可被用來跳到任意站，這是產品責任，Bridge 擋不了。
- 建議修法：登記時拒絕公共後綴（內建 Public Suffix List 或至少拒絕 eTLD+1 以下的登記）；後台文件註明子網域語意；選擇性提供「僅精確比對」開關（lm-3b-plan §8.3 已提過）。
- 要不要加測試：要。

### L-05 LINE 403 一律把該使用者所有連結標成 blocked 且不會自癒；unfollow／follow 沒有時序比對

- 位置：`worker_src/bridge/notify.js:268-279, 307-309`、`worker_src/bridge/db.js:753-776`、`lib/event_handler.js:356-357, 405-406`
- 情境（讀碼推論，沒有 LINE 真實行為證據）：
  1. 任何一次 LINE 403 都會 `markContactsBlockedByUser`，把這個 bot 下**同一個 LINE 使用者在所有連結**的綁定標成 blocked；`blocked` 之後 `getContactForSend` 在不打 LINE 的情況下直接回 `RECIPIENT_BLOCKED`，只有收到 follow 事件才會還原。若 403 不是真的封鎖（暫時性或非使用者因素），這是黏住的偽陽性；一個產品的狀況影響到其他產品。
  2. webhook 事件在 `waitUntil` 內處理，unfollow 與 follow 可能亂序到達；`markContactsBlockedByUser`／`restoreContactsByUser` 是無條件更新，沒有比對 `event.timestamp` 與 `updated_at`。亂序時結果是「實際已解除封鎖但記為 blocked」。
- 影響：可用性。產品會看到持續的 `RECIPIENT_BLOCKED`。恢復路徑是產品重新發碼並由客戶重新綁定。
- 建議修法：403 之後不要直接把其他連結一併標 blocked，或至少只標目前這一條；`blocked` 狀態加重試（例如 24 小時後允許再試一次）；事件處理加 `event.timestamp`／`webhookEventId` 比對，晚到的舊事件不覆蓋較新的狀態。
- 要不要加測試：要（亂序 unfollow／follow；403 後可恢復）。

### L-06 撤銷與停用只在請求開頭檢查一次；產品停用後綁定仍被確認

- 位置：`worker_src/bridge/auth.js:104-136`、`worker_src/bridge/db.js:636-657, 723-731`、`worker_src/bridge/notify.js:304-336`
- 情境與證據：
  1. 撤銷後新請求立即 `LINK_REVOKED`（`e5_matrix.mjs`：撤銷後送訊息 403 LINK_REVOKED、GET contact 403 LINK_REVOKED，沒有任何 push）。但已通過認證、正在 `execute` 的請求不會再看連結狀態：`getContactForSend` 沒有 join `links.status`，請求進行中撤銷仍可能送出（毫秒到數秒的視窗，LINE 呼叫無逾時，見 L-12，視窗可能更長）。
  2. `consumeBindCode` 只檢查連結 active，不檢查 `products.disabled`；產品停用後，客戶傳來的有效綁定碼仍會被消耗、寫入並回覆「已完成綁定，之後會在這裡通知你」（`e7_misc.mjs`：handled=true），但之後 `authenticateLink` 會擋住所有發送。客戶被誤導。
- 影響：低。
- 建議修法：`getContactForSend` 改成 `JOIN links l ON … AND l.status='active' JOIN products p … AND p.disabled=0`；`consumeBindCode` 的 EXISTS 條件加上產品啟用。
- 要不要加測試：要。

### L-07 資料保留與成長：`contacts.line_user_id` 在連結撤銷後永久保留；`idempotency`、`audit_log` 沒有清理

- 位置：`migrations/0003_bridge_contacts.sql:22-31`、`worker_src/bridge/db.js:738-746, 798-853, 901-918`
- 證據：`grep` 全部 `DELETE FROM`——只有 `deleteContact`（需有效連結金鑰）、`releaseIdempotency`（只刪 in_progress）、發碼時順手清過期的 auth_codes／bind_codes。`e4_drills.mjs` G2：明確撤銷連結後，contacts 列仍在已撤銷的連結下，LINE userId 還在。
- 影響：隱私（個資刪除要求、產品離開後仍保留客戶 LINE userId）；儲存成長（單一連結每天最多 86,400 次發送，每次一列 idempotency 與一列 audit_log）。
- 建議修法：連結撤銷時（或撤銷後 N 天，預設 30）刪除該連結的 contacts／bind_codes；`claimIdempotency` 或排程（Cron Trigger）清掉 `expires_at < now - 1d` 的 idempotency；`audit_log` 訂保留期（例如 400 天）；提供 owner 後台「刪除某客戶的綁定」。
- 要不要加測試：要。

### L-08 webhook 的全域密鑰退路讓持有者可偽造 Bridge 會處理的事件

- 位置：`worker_src/handler/webhook.js:50-69`、`worker_src/lib/event_handler.js:195-212, 356-357, 405-406`
- 情境：bot 沒有登記自己的 channel secret，且 `WEBHOOK_GLOBAL_SECRET_DISABLED` 未設為 `1` 時，簽章改用全域 `LINE_CHANNEL_SECRET` 驗證。持有該密鑰的人（例如全域密鑰所屬 OA 的管理者）可以對任一未登記的 bot 偽造事件：(a) 任意 `lineUserId` 的 message 事件，繞過 M-02 以 LINE userId 為鍵的猜碼限流；(b) 任意使用者的 unfollow，把他們的綁定標 blocked（L-05）。
- 證據：讀碼；簽章比對本身是常數時間且 `destination` 只決定用哪把密鑰（`signature.js`、`webhook.js` 註解正確）。
- 建議修法：啟用 Bridge 之前的上線檢查清單加入「所有 bot 已登記 channel secret，且 `WEBHOOK_GLOBAL_SECRET_DISABLED=1`」；`/features` 或 health 在 Bridge 開啟且仍允許全域退路時在稽核或告警中標出。
- 要不要加測試：設定檢查性質，加在 deploy:check 即可。

### L-09 認證之前的 D1／外部呼叫沒有限流（成本放大）

- 位置：`worker_src/bridge/index.js:59-72`（`/health` 每次 `SELECT 1`）、`worker_src/bridge/links.js:256-270`（`/link/authorize` 每次 `getProduct`）、`worker_src/bridge/auth.js:104-136`（任何假金鑰都會打一次 D1）、`worker_src/middleware/auth.js:23-72`（每個 Bearer 都對 api.line.me 打兩次 fetch）
- 影響：未認證者可線性放大 D1 讀取與對 LINE 的子請求，沒有 429。這是 LM 既有模式延伸到 Bridge，成本與可用性問題，不是越權。
- 建議修法：在 Cloudflare 層加 rate limiting rule（路徑 `/lm/bridge/*`），或 Worker 內以 IP 做一個便宜的前置限流；`/health` 可以只在帶特定標頭時才查 D1。
- 要不要加測試：不需要（部署層設定）。

### L-10 營運密鑰：沒有強度下限、失敗不稽核、限流 fail-open、端點存在可探測

- 位置：`worker_src/bridge/links.js:197-229`
- 證據：比對本身正確（雙方 SHA-256 後 `timingSafeEqual`，`links.js:111-115, 208`）；限流 `lnkadmin.{ip}` 每分鐘 10 次，`e4_drills.mjs` E 的 KV 缺或錯時全放行；沒有最小長度檢查（`e7_misc.mjs` 以 2 字元的密鑰就能正常運作）；失敗的嘗試不寫 `audit_log`；密鑰未設定時回 404，設定後回 401——可探測部署是否啟用了營運端點。
- 影響：若營運密鑰是人類可記的字串，且限流在 KV 異常時失效，就有被線上猜測的可能。這個端點能發出新的產品與密鑰，但發出的產品仍需要 owner 在同意頁按同意才能連到任何 OA，所以不是直接越權。
- 建議修法：啟動時檢查 `BRIDGE_ADMIN_SECRET` ≥ 32 字元高熵（檢查失敗視為未設定）；失敗嘗試寫稽核（`actor_id` 用 IP 雜湊）；改用 D1 原子計數做失敗鎖定；未設定與設定錯誤統一回 401。
- 要不要加測試：要（短密鑰被拒；連續失敗後鎖定）。

### L-11 綁定碼與授權碼只以未加鹽的 SHA-256 儲存：D1 外洩後 40 bit 的綁定碼可離線還原

- 位置：`worker_src/bridge/db.js:599-627`、`migrations/0003_bridge_contacts.sql:7-15`
- 說明：服務金鑰、連結金鑰、產品密鑰、授權碼都是 256 bit CSPRNG，未加鹽的 SHA-256 在這個熵下是適當的（我不列為問題）。綁定碼不同：2^40 的空間用 SHA-256 暴力遍歷在 GPU 上是分鐘到小時級（依公開基準的估算，**沒有實跑**）。D1 若被讀取（備份外流、Console 帳號被盜），所有未過期的待綁定碼都可還原，攻擊者可先於客戶把自己的帳號綁上去。但能讀 D1 的人同時拿得到 `contacts.line_user_id`，這項是「縱深防禦」。
- 建議修法：碼的雜湊改為 HMAC-SHA-256（pepper 放在 Worker secret，不在 D1），或與 M-02 一起把碼加長到 ≥ 64 bit 使離線窮舉不可行。
- 要不要加測試：要（雜湊結果依賴 pepper）。

### L-12 LINE API 呼叫沒有逾時；「月額度用盡」靠訊息字串比對

- 位置：`worker_src/lib/line_api.js:53-76`、`worker_src/bridge/notify.js:280-287`、`worker_src/bridge/messages.js:159-171`
- 說明：`postMessages` 沒有 `AbortSignal`，LINE 慢或卡住時請求會一直掛著，冪等的 in_progress 紀錄 2 分鐘後可被接手（`IDEM_IN_PROGRESS_TTL_MS`，`db.js:18`），此時第二個請求以同一個 retry key 打 LINE，LINE 回 409 被當成功，不會重複投遞（我檢視了邏輯，這一步是對的）；問題是撤銷／配額檢查的視窗會被拉長（L-06）。429 是否為月額度用 `/monthly limit/i` 比對 LINE 回應文字，文字一旦變動就會被當成可重試的 `RATE_LIMITED`，產品會一直重試。
- 建議修法：`fetch` 加 `AbortSignal.timeout(10_000)`；月額度判斷改成依 `quota/consumption` 的對帳結果輔助，而不只看訊息。
- 要不要加測試：要（逾時映射成 502 retryable）。

---

## Info

- **I-01 CORS 與快取標頭**：`/raw/*`、`/health` 與 systems 的錯誤回應用 `jsonResponse(body, status)` 不帶 request，`resolveAllowedOrigin` 退回字串 `"null"`，於是回 `Access-Control-Allow-Origin: null`（`worker_src/lib/utils.js:78`，`e6_cors.mjs` 實測）。沒有 Cookie 認證，攻擊者仍須持有 Bearer 金鑰，所以沒有實際影響。`bridgeError` 的錯誤回應沒有 `Cache-Control: no-store`（成功回應有）；錯誤本文不含機密。
- **I-02 稽核的 `actor_id`**：`user` 類事件（`link_authorized`、`link_revoked`、`system_*`）的 `actor_id` 是 LM 操作者（owner）的 LINE userId，不是聯絡人的。與 migration 註解「不含 LINE userId 全文」只指 `detail` 欄位。`e5_matrix.mjs` 的洩漏掃描確認：聯絡人的 userId、ref、LINE token、金鑰都不在 log、audit_log、idempotency 中。
- **I-03 同意頁的外部資源**：`pages/link_authorize.html:16-17, 246` 從 jsDelivr 載入 Bootstrap CSS 與 bootstrap-icons，沒有 SRI；LIFF SDK 來自 LINE CDN（SRI 不可行）。沒有 CSP（frame guard 只設 `frame-ancestors`）。CDN 被入侵時，同意頁可被改寫。建議自行託管 CSS 並加 SRI 與基本 CSP。
- **I-04 `redirect_uris` 驗證**：營運登記時 `https://localhost./cb`、`https://0.0.0.0/cb`、`https://[::ffff:7f00:1]/cb` 通過（`e7_misc.mjs`；`127.1`、`2130706433` 被擋）。僅營運可登記，所以是登記失誤風險。
- **I-05 logger 目前是空函式**：`utils/logger.js` 的 `info`／`debug` 沒有內容，所以 `event_handler.js:215` 的 `使用者訊息: "…"` 不會進 log。一旦有人恢復 logger，**未被消耗**的有效綁定碼（群組／聊天室訊息、被限流、D1 失敗時）會被記錄。建議加測試釘住「綁定碼形狀的文字不進任何 log 輸出」。
- **I-06 `AUTH_MODE=legacy`**：若在正式環境誤設，`approve`、`/admin/links`、`/systems` 這些人主體端點會接受自報的 `X-User-Id`。目前 `wrangler.jsonc` 是 `liff` 且有測試把關，此項只是提醒 Bridge 的信任根在這個旗標。
- **I-07 設計內的差異**：同一連結內 `CONTACT_NOT_BOUND` 與 `RECIPIENT_BLOCKED` 與時間差可供產品得知客戶是否封鎖（規格本來就回報）；跨連結的 ref 一律 `CONTACT_NOT_BOUND`（`e5_matrix.mjs` 實測）。冪等重播也會消耗每聯絡人的小時額度（lm-3b-plan §12.2 已記載）。
- **I-08 營運操作缺口**：沒有產品密鑰輪替或停用的 API，只能在 D1 Console 改 SQL；`link:manage` 可輪替連結金鑰但不能輪替產品密鑰。授權時使用者無法縮減 scope（`handleApprove` 一律給產品登記的全部 scope）。

---

## 已檢查且沒問題（含實測）

AuthN／AuthZ
- 金鑰型別混用矩陣（`e5_matrix.mjs`，經 `handleBridge` 端到端）：系統金鑰打 `/messages` → 401 INVALID_KEY；連結金鑰打 `/raw/push` → 401；產品密鑰、營運密鑰當 Bearer → 401；系統金鑰打 `/systems`（需 LIFF）→ 401。
- 跨連結／跨產品（同 bot）：連結 B 對連結 A 的 ref 發送 → 409 CONTACT_NOT_BOUND；GET 是 unbound；DELETE 回 204 但**沒有**刪到 A 的綁定（隨後 A 仍是 bound）；GET／DELETE／rotate 他人 link_id → 404；跨 bot 的 `X-Bot-Id` 對 `/raw` → 403 Bot mismatch。
- 每條路由的 scope 檢查（`link:manage`、`contacts:bind`、`messages:send`、`raw:push`）；`principal.scopes` 是 金鑰 ∩ 連結 ∩ LINK_SCOPES，資料庫即使被寫入 `raw:push` 也不會被當權限。
- 撤銷連結後立即拒絕（見 L-06 對 in-flight 的說明）；輪替掉的舊金鑰 → INVALID_KEY；重授權時舊金鑰與連結在同一 batch 撤銷。
- 秘密比對：產品密鑰、營運密鑰皆為「雙方 SHA-256 後 `timingSafeEqual`」；金鑰以雜湊查 D1 索引，攻擊者無法由計時推得內容。

授權碼流程
- `redirect_uri` 逐字元精確比對；不通過回 400，不導向。`consumeAuthCode` 的單一 UPDATE 綁定 product 與 redirect_uri：錯的 redirect_uri、錯的產品都**不會**消耗合法的碼（`e4_drills.mjs` H）；20 個並行消耗只有 1 個成功。5 分鐘有效。
- `Location` 與 `redirect_to` 一律由 URL API 組出，`state` 長度受限且被編碼；`cancel_redirect_to` 為已驗證位址；前端 `validateRedirectTarget` 再驗一次 origin 與 path。approve 需要 LIFF Bearer（非 Cookie），所以沒有傳統 CSRF；owner 以 `bot:{id}:permissions` 重新驗證，不信任 body 的 ownerId；bot_id 竄改 → 404。LIFF token 的 `client_id` 與 `LIFF_CHANNEL_ID` 比對。
- sessionStorage 備援：只能被同源頁面寫入，備援參數仍要通過後端的精確比對，用完即清。

綁定
- 並行 30 個 LINE 帳號送同一碼只有 1 個綁定成功（`e4_drills.mjs` B）；別的 bot 的 webhook 不能使用（C）；形狀不符的文字零 D1 查詢；查無此碼不回覆（無猜碼判斷機）。
- 重綁政策、unfollow 與 follow 的 SQL 範圍都限定在 `(bot_id, line_user_id)`。

訊息
- action.url 白名單模糊測試 31 個案例（`e1_url.mjs`）無繞過：userinfo、反斜線、`#`／`?` 偽裝、`%2E`、`。`、全形字母、IDN／punycode、尾端點、埠、IPv4／IPv6／十進位／十六進位 IP、非 https、控制字元與空白、超長。送給 LINE 的是 `new URL().href` 的正規化結果。
- 未知欄位被拒（含 `__proto__`）；重複鍵取最後一個；超大 body 回 413；所有 body 讀取都在認證之後。
- 冪等：20 個並行搶佔只有 1 個贏（`e4_drills.mjs` F2）；`system` 欄是 `link:{id}`，不同連結互不影響；同鍵不同內容 → 422；in_progress 2 分鐘後可接手；LINE 409 視為成功且 retry key 綁 `bot|link:{id}|key`。
- 回應、audit_log、idempotency、console 輸出不含聯絡人 LINE userId、ref、LINE token、金鑰（`e5_matrix.mjs` 洩漏掃描：全部 false）；回應不含 stack。

資料與基礎設施
- 所有 SQL 都在 `bridge/db.js` 且全部是 bound parameter；唯一的 `${}` 插值是常數 `SYSTEM_COLUMNS`；`BRIDGE_DB` 只在 `bridge/` 讀取。`sanitizeDetail` 是白名單，每個欄位有格式檢查。
- 缺 `BRIDGE_DB` 或查詢失敗 → 503（fail-closed，不退回 KV）；`BRIDGE_ENABLED` 只認 `"1"`，關閉時 `/bridge/*` 一律 404。
- 敏感回應（金鑰、授權碼、連結）都帶 `Cache-Control: no-store`；links／contacts 回應不帶 CORS 標頭。
- DOMAIN_RE、HOSTNAME_RE 沒有 ReDoS（`e8_redos.mjs`）。
- webhook 簽章驗證為常數時間，且 `destination` 只用來挑密鑰。
- 管理頁（`system_management.js`）全部用 `textContent`／`createElement`，沒有 `innerHTML`；金鑰只顯示一次且 no-store。
- Bridge 與 LM 的 import 邊界：`bridge/` 只經 `lm_service.js`（由既有邊界測試把關）。

---

## 建議的處理順序

1. M-01、M-02：先做 D1 原子預算與嘗試計數，這是目前唯一會被實際濫用的面；順便把綁定碼加長並縮短 TTL。
2. M-03：同意頁顯示回調主機、規格加 MUST；改動小。
3. L-01、L-02、L-06：小改動、有明確測試。
4. L-07 與 L-08：上線前的保留政策與設定檢查。
5. 其餘依產品開放程度排程。

啟用 `BRIDGE_ENABLED=1` 給**單一受信任產品**時，上面沒有任何一項是阻擋條件；對外開放多租戶產品之前，M-01～M-03 應先處理。
