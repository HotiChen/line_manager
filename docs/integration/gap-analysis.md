# Bridge 整合：差距分析與工單重排（WP-0C，LM 側）

狀態：**待 G0 確認**。對象：整合規格書 v1.0（私有文件，不在本 repo）與目前 LM 實作。
事實依據：[`lm-audit.md`](lm-audit.md)。契約草稿：[`bridge-v1.yaml`](bridge-v1.yaml)。
本文件只談 LM 這一側；另一個產品的現況盤點與工單在它自己的 repo。

## 1. 結論

方向一致，可行。落差有三類：**要補的前置問題（P0）**、**與規格不同、已決定的取捨**、**Bridge 本身要補的東西**。
P0 兩項不處理，Bridge 做出來也無法對「別的商家」使用。

## 2. 假設驗證

| 假設 | 結果 | 依據 |
|---|---|---|
| A1：LM 已有 Bridge Auth／Messages／Systems | **部分成立**：有認證、scope、冪等、限流、額度對帳；沒有 products、links、授權碼、綁定、受限格式、audit log | lm-audit §1 |
| A2：能新增 D1 binding | **預期可行，未驗證**：wrangler 3.114.17 支援；需 SQL migration 目錄、D1 測試 helper、dev／prod 各自宣告、deploy token 的 D1 權限 | lm-audit §7 |
| 規格隱含「商家」層 | **不成立**：LM 沒有商家／組織層，使用者直接擁有 bot | lm-audit §2 |
| Bridge 只經窄介面使用 LM | **目前不成立**：直接 import 三個 LM 內部模組 | lm-audit §5 |

## 3. P0：Bridge 之前必須先處理

### P0-1　webhook 只能驗證一個 LINE channel
`webhook.js:41` 只讀一個全域 `LINE_CHANNEL_SECRET`。每個 LINE channel 的 secret 不同，所以**除了 secret 恰好相同的那個 OA 之外，其他 OA 的 webhook 現在都會被 401 拒絕**（2026-11-11 起強制驗簽後）。
影響：其他商家的 OA 收不到事件；「綁定碼訊息」要靠 webhook，所以也不能用。
待確認（需要 Tim）：LINE Console 裡，你名下其他 OA 的 Webhook 是否顯示錯誤，或實際傳訊息看有沒有反應。
方向：每個 bot 存自己的 channel secret（`BotKeys.credential` 已預留，加密沿用 `token_crypto`），驗簽時先用 body 的 `destination` 選出 secret（只用來選 secret，驗證仍以 HMAC 為準），找不到才退回全域 secret；token 註冊流程補「Channel Secret」欄位。

### P0-2　註冊 token 不會建立權限紀錄
`/token/register`（`token.js:137-154`）不寫 `bot:{id}:permissions`／`owner`，只有 migration 會寫。新註冊的使用者呼叫 `/api/v1/systems`、`/team/*`、`/member/demo/*` 會得到 403。
方向：註冊時冪等地建立 owner 與 permissions（不覆蓋既有成員），並補一個修復既有資料的 migration 模式。

### 已在本輪修復（`6383a62`）
邀請清單跨 bot 外洩；測試會員 store 與權限檢查的 bot 不一致。

## 4. 與規格不同、已決定的取捨

| # | 規格 | 決定 | 理由 |
|---|---|---|---|
| D-1 | 只有受限訊息 | **兩層**：連結流程的金鑰只能用受限格式 `/messages`；原樣轉送改名 `/raw/*`，scope `raw:push`，只給 owner 手動發放的信任金鑰 | 保留 LM「平台不知道內容」的原則，同時擋住第三方釣魚訊息 |
| D-2 | `/bridge/v1`、D1、`brk_` | **採用**；現在改，因為沒有外部使用者 | 成本最低；KV 無原子操作是冪等、一次性碼、撤銷一致性的共同根因 |
| D-3 | 聯絡人綁定走 LINE Login | **改為綁定碼訊息**（客戶傳碼給 OA，webhook 取得 userId） | 不依賴 LIFF 與 OA 同 Provider（無法確認，見 lm-audit §6）；不需要額外 LINE Login |
| D-4 | `platform_merchants`、`lm_merchant_id` | **MVP 不做**；連結綁到 bot 即可 | LM 沒有商家層；規格本身也把它延後（D4） |
| D-5 | `link:read` 可刪除與換鑰 | **改名 `link:manage`**；只能換自己這條連結的金鑰 | 名稱與行為一致，維持「金鑰不能發金鑰」 |
| D-6 | 規格放兩個 repo | 規格在**私有** repo；本 repo 只放 LM 側的契約與報告 | 公開 repo 不放其他產品的內部細節 |
| D-7 | 錯誤格式 `{error:{code,message,retryable}}` | 新介面採用；`/raw/*` 過渡期維持舊格式 | 舊格式目前沒有外部使用者，但先不破壞既有測試 |

## 5. Bridge 本身要補的（LM 側工單，重排後）

目前已完成的部分直接沿用，不重做：service key 認證、scope、per-system 限流、冪等推播、額度對帳、封鎖／額度錯誤對映。

| 工單 | 內容 | 狀態 | 相依 |
|---|---|---|---|
| **LM-0A** | P0-1：每 bot channel secret＋webhook 驗簽改版 | 待辦 | 無 |
| **LM-0B** | P0-2：註冊時建立 owner／permissions＋修復 migration | 待辦 | 無，可與 0A 平行 |
| **LM-1A** | `BRIDGE_ENABLED` flag（預設關，關閉時 `/bridge/*` 404 且後台不顯示入口）；搬到 `worker_src/bridge/`；`lm_service.js` 窄介面；ESLint 邊界規則；路徑改 `/bridge/v1` | 待辦 | G0 |
| **LM-1B** | `BRIDGE_DB`（D1）＋migration；D1 測試 helper；service key、系統、冪等、audit_log 移到 D1；products 註冊 | 待辦 | LM-1A |
| **LM-1C** | `brk_` 金鑰格式（前綴＋雜湊）；新錯誤格式；`raw:push` scope 改名；audit_log 寫入；系統註冊 race 修正（D1 唯一約束） | 待辦 | LM-1B |
| **LM-1D** | 契約測試：同一份 `bridge-v1.yaml` 驗證 LM 實作 | 待辦 | LM-1C |
| **LM-2A** | 授權碼流程：`/link/authorize`、`/links/token`、`/links/{id}`（查詢、解除、換鑰）、同意頁、後台「已連結的產品」 | 待辦 | LM-1C |
| **LM-3A** | 聯絡人綁定：`bind-tokens`、webhook 偵測綁定碼、狀態查詢（不回 userId） | 待辦 | LM-0A、LM-2A |
| **LM-3B** | 受限 `/messages`：格式驗證、`action.url` 白名單、`external_contact_ref` 解析、D1 冪等、額度與封鎖對映 | 待辦 | LM-3A |
| **LM-3E** | 與另一個產品端對端；故障演練；`/security-review` | 待辦 | LM-3B＋對方的工單 |

順序：`LM-0A／0B → G0 → LM-1A → 1B → 1C → 1D → 2A → 3A → 3B → 3E`。LM-0A／0B 與 G0 可同時進行，不必等待。

## 6. 不可破壞清單（LM 側，初版）

1. LM 的獨立註冊、登入、官方帳號管理、CRM 照常；`BRIDGE_ENABLED` 關閉時所有行為與現在相同。
2. 既有 `/api/send-message`（後台推播）、webhook 事件處理、Rich Menu、關鍵字、標籤、等級不因 Bridge 改變。
3. LM Core 不得 import `worker_src/bridge/**`（CI 驗證）；Bridge 只經 `lm_service.js` 使用 LM。
4. 不直接讀寫其他產品的資料；不把其他產品的照片或檔案經過 LM。
5. LINE userId 不回傳給呼叫端；log 不出現金鑰、LINE userId 全文、訊息內文。
6. 802＋既有測試全過，不刪改既有測試來讓它通過。
7. 公開 repo 不得出現任何 secret、`.dev.vars`，或其他產品的內部細節。

## 7. 風險

| 風險 | 說明 | 緩解 |
|---|---|---|
| 其他 OA 的 webhook 現在是壞的（P0-1） | 影響所有非 secret 相同的 OA | 優先處理；Tim 先查 LINE Console |
| D1 工具鏈 | CI 用 Node 20，內建 SQLite 測試支援有限；需要新的 test helper | LM-1B 先決定 helper（候選：`better-sqlite3` 當 devDependency） |
| 綁定碼 deep link | 預填訊息的 OA 連結需要 OA 的 basic ID；`/v2/bot/info` 是否回傳需實測 | LM-3A 第一步先用真實 OA 驗證，驗證不過就改顯示文字讓客戶手動輸入 |
| 撤銷一致性 | KV 撤銷在其他邊緣節點可能延遲 | 搬到 D1 後撤銷以資料庫為準；搬遷前不對外發放金鑰 |
| 投入量 | 每週 5–10 小時，不可同時推進多個階段 | 嚴格照順序；MVP 只做到 LM-3E |

## 8. G0 檢查表（Tim）

- [ ] 同意第 4 節七項取捨
- [ ] 同意 LM-0A／0B 先做（這兩項不依賴 G0）
- [ ] 查 LINE Console：其他 OA 的 webhook 是否正常（影響 P0-1 的急迫度）
- [ ] 確認規格第 13 節：額度用商家自己的 OA；綁定保留 30 天；未綁定時提示商家
- [ ] 契約 `bridge-v1.yaml` 的欄位長度（`title` 40／`body` 300）依 LINE 限制確認後再凍結
