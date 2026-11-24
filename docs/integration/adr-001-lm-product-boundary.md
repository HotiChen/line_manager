# ADR-001：LM 與垂直產品(Image Picker 等)的分工

- 狀態：**已採納(討論定案)**，2026-11-24，Tim
- 適用：`line_manager`(LM)與所有透過 Bridge 接入的產品(第一個是 Image Picker，下稱 IP)
- 相關：`bridge-v1.yaml`(現行契約)、`bridge-v1.1-draft.md`(下一版草案)、`image-picker-handoff.md`

## 1. 背景

IP 接上 LM 後，每討論一個新功能(對個別客人發訊息、群發、Rich Menu、關鍵字查進度、我的相片)都會碰到同一個問題：「這個功能放 LM 還是 IP？」而且會一再撞到同樣三個缺口：

1. LM 收到的 LINE 事件沒辦法交給產品處理；
2. 沒有「這個 LINE 帳號是哪位客人」的身分機制；
3. LM 的 postback 不會依 data 分流(目前一律回「已收到您的操作：<原始 data>」)。

為了長期維護、不再一直調整架構，這份文件一次把分工定下來。

## 2. 決定

### 2.1 三條原則(不再重新討論)

1. **LM 只管 LINE 管道**：OA 的 token 與 webhook、收發訊息、Rich Menu、固定回覆(關鍵字、`lm:` postback)、額度、封鎖狀態、LINE userId。
2. **產品管業務與客人**：客人資料、案子、方案、作品集、進度、客人身分。**CRM 只有一份，在產品。** LM 不保存產品客人的姓名、電話、Email。
3. **兩邊只透過 Bridge 契約溝通**，而且契約**只能新增，不能修改或刪除**。舊欄位、舊行為永遠有效；新能力用新的 scope 與旗標開啟。

### 2.2 資料歸屬：內容的主人在哪，資料就放哪

會變動、和業務有關的內容(方案、價目、作品集、進度)由產品維護、由產品回答。LM 不另外存一份副本。

### 2.3 功能放哪(對照表)

| 功能 | 放哪 | 走哪條路 |
|---|---|---|
| Rich Menu 的版面與切換 | LM | LM 後台 |
| 固定回覆(營業時間、聯絡方式) | LM | 關鍵字回覆，或 `lm:` 開頭的 postback |
| 作品集(以圖片為主) | 產品 | Rich Menu **網址按鈕**直接開產品頁面，不經過轉發 |
| 方案、價目摘要 | 產品(**IP 目前例外：暫留 LM 的固定回覆**，因為 IP 決定不做方案／套裝；見 IP `docs/line-v1.1.md` L0) | `px:<product_key>:<action>` 開頭的 postback → 事件轉發 → LM 用 reply 回覆 |
| 查自己的進度 | 產品 | 同上，事件帶 `external_contact_ref` |
| 我的相片／客人入口 | 產品 | LINE 身分換 ref(v1.1 草案 §C) |
| 交件通知、紀念日問候、過濾客人群發 | 產品決定時機與對象 | `POST /messages`(現行 v1) |
| 對所有 OA 好友群發 | LM 或 LINE 官方帳號管理 App | LINE 本身的群發 |
| 和客人手動 1 對 1 聊天 | LINE 官方帳號管理 App | (不在任何一邊) |

### 2.4 契約要補的三項(v1.1，全部是新增)

每一種 LINE 功能(Rich Menu、Flex、Imagemap、Quick Reply、關鍵字……)放哪、按鈕怎麼接：`lm-product-feature-map.md`。

細節見 `bridge-v1.1-draft.md`：

- **A. postback 命名規則**：`lm:` 由 LM 處理；`px:<product_key>:` 轉給產品；沒有前綴的維持舊行為。
- **B. 事件轉發(同步回覆)**：LM 把 `px:` 開頭的 postback 轉給產品，最多等 2.5 秒；產品及時回覆就用 reply 送出(不花額度)，逾時或出錯就回設定好的備用內容(文字＋網址按鈕)。
- **C. LINE 身分換 ref**：客人從 LIFF 進入，LM 驗證 LINE 身分後，發一組一次性的碼給產品；產品在伺服器端用這組碼換出 `external_contact_ref`。產品永遠拿不到 LINE userId。

### 2.5 實作順序：介面先定好，用到才做

1. 本 ADR 與 v1.1 草案(只有文件)。
2. A：postback 分流(範圍小，Rich Menu 現在就用得到)。
3. B：做「查進度」或「方案」聊天室回覆時才做。
4. C：做「我的相片」時才做。

每一步都是新增，不會動到已完成的部分。

## 3. 後果

**好處**
- 新功能大多只需要在產品新增一個 `px:` 動作的處理，LM 和契約都不用改。
- 個資邊界維持不變：LINE userId 只在 LM，客人資料只在產品。
- 第二個產品接入時，沿用同一套 A、B、C。

**代價**
- 事件轉發讓「方案查詢」依賴產品在線；靠備用內容兜底。
- C 有平台限制：LINE userId 是「依 Provider 區分」的(見 v1.1 草案 Q1)，LIFF 必須和 OA 屬於同一個 Provider 才拿得到同一個 userId。

## 4. 明確不做

- LM 不做客人 CRM(標籤、分眾、客人姓名)。LM 現有的 `member`／`tag` 功能只用在「LM 自己的關鍵字與 Rich Menu」，不和產品的客人資料同步。
- 產品不重做關鍵字回覆、Rich Menu、OA 設定。
- 不把 LINE userId、顯示名稱、頭像或 replyToken 交給產品。
- 不為了「晚到的產品回應」改用 push 補送(會花額度)。

## 5. 待 Tim 決定

- **IP 的舊客人帳號系統**(`client-login.html`、`/api/auth/register|login`，目前 `LEGACY_CLIENT_ACCOUNTS = "off"`)：建議**刪除**，由 C 取代，不要修。這件事在 IP repo 決定與執行。
