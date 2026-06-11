# 🎯 整合分析:提案總覽 × 趨勢偵察 × line_manager 資產(2026-06-11)

> 整合三份資料產出:📋 SaaS 提案總覽(5/18)、🔍 趨勢側翼機會偵察(6/07-6/11)、line_manager 程式碼修復完成(本週:LIFF 認證 fail-closed 加固、CI、測試全綠)。

---

## 核心結論

**你不是在 13 個提案裡挑一個,你是在做一個「LINE 原生的微型生意作業系統」**——PhotoFlow、TailorFlow、團購對帳、跑團管家,全部是同一顆引擎(預約+會員+通知+金流)換不同的垂直外皮。line_manager 就是引擎 v0。

三份資料互相印證:
1. 提案總覽評分最高的 PhotoFlow/TailorFlow,共同邏輯是「你就是用戶+圈內人脈」= 不公平優勢
2. PhotoFlow 5/18 寫的最大風險「LINE LIFF 學習曲線」**已在本週付清**——line_manager 有現成的 LIFF 認證、會員 CRM、推播、webhook、後台
3. 趨勢偵察的結論「微型生意活在 LINE 群+Excel、工具真空」與提案 portfolio 是同一論點

---

## 最終排序

| 順位 | 提案 | 行動 | 關鍵理由 |
|---|---|---|---|
| 🥇 現在做 | 📷 PhotoFlow | 本週訪談 3 位攝影師驗證付費意願,3/3 願付 NT$299/月才動工 | 唯一同時滿足:自己是用戶、種子用戶在身邊、技術 70% 現成、B2B 級付費意願 |
| 🥈 第二做 | ✂️ TailorFlow | PhotoFlow 引擎跑通後啟動 | 建議改:v1 改走「IG 導流到 LINE、LINE 內完成報價收訂金」,繞掉 Meta API 權限風險、100% 重用引擎 |
| 🥉 第三做 | 🧾 MatchOrder 或 🏃 跑團管家(趨勢偵察新增) | 用前兩者的驗證結果決定 | MatchOrder 痛點真實但銀行 CSV 是長期苦工;跑團有 6-12 個月趨勢窗口但團長付費意願弱 |
| 💰 週末專案 | 🔮 合八字印章(AI 報告半套) | 不用等買機器,知識庫+Claude+收款頁即可上線 | NT$299/份、維運近零、競爭者零、爸爸的知識是真護城河;非 SaaS 主線但零風險現金流 |

## 降級與擱置

| 提案 | 原判斷 | 覆核後 | 理由 |
|---|---|---|---|
| 🪑 SeatAI | 第二做 | 之後考慮 | 單場 NT$499 是一次性交易非訂閱;需婚顧 BD;與主線引擎零共用 |
| 📱 Creator-Vault | 第一做 | 之後考慮 | 創作者工具是 Buffer/Typefully 紅海;Meta API 權限風險在多個提案反覆出現 |
| 🛡️ SafePulse | 第三做 | 維持擱置 | iOS/Android 背景執行是焦油坑;資本額 80K 前三高 |
| 🏘️ LittleHelp / 🐉 龍珠雷達 | 需要夥伴/地推 | 維持擱置 | 停對了 |
| 📸 作品集行銷 | 之後考慮 | 維持 | 終局是 PhotoFlow 的一個功能,不是獨立產品 |

---

## line_manager → PhotoFlow 技術改造路線圖

### 直接重用(約 60-70% 的基礎設施)

| line_manager 模組 | PhotoFlow 用途 |
|---|---|
| middleware/auth.js(LIFF 認證,剛完成 fail-closed 加固) | 客戶/攝影師登入,直接用 |
| handler/token.js(多帳號 LINE OA token 管理) | 多租戶基礎:每位攝影師接自己的 OA |
| member.js + tag/tier 系統 | 客戶 CRM + 狀態機(詢價→訂金→已拍→挑片中→待尾款→結案) |
| push_message + line_api(retry 邏輯) | 催挑片/催尾款推播 |
| webhook + keyword_reply + event_handler | 自動回覆、檔期詢問 |
| richmenu builder | 攝影師 OA 的圖文選單 |
| tests/mock_kv + CI + CLAUDE.md TDD 守則 | 開發基礎,直接沿用 |

### 需要新寫

1. **行事曆預約頁(LIFF)**+ 訂金收款
2. **照片上傳管線**:批次浮水印+壓縮 → Cloudflare R2(R2 免 egress 費;「大圖 14 天自動清除」可用 R2 lifecycle rule 原生實現——提案裡的需求剛好是 R2 內建功能)
3. **挑片 LIFF UI**:點愛心選片 + Lightroom 標籤格式匯出
4. **金流**:LINE Pay / 綠界(訂金+尾款)
5. **催款排程**:Cloudflare Cron Triggers + Claude API 幽默催款文案
6. **攝影師自助 onboarding**(接 OA、設定檔期)

### 架構升級(原 P1/P2 技術債變成 PhotoFlow 前置工程)

- 訂單/預約資料用 **D1**(需要關聯查詢:訂單×客戶×照片),會員/設定留 KV
- dev/prod KV namespace 分離(原本就該做)
- **token 加密存放**(商業必須,不再只是安全建議)

### 修訂時程:8 週 → 6 週(因引擎現成)

| 週次 | 任務 |
|---|---|
| W1 | 3 位攝影師訪談驗證 + D1 schema + R2 設定 |
| W2 | LIFF 預約頁 + 訂金金流 |
| W3 | 照片上傳管線(浮水印/壓縮/R2) |
| W4 | 挑片 UI + Lightroom 匯出 |
| W5 | 催款排程 + AI 文案 |
| W6 | 3-5 位攝影師 Beta |

**維運成本修訂**:原估 NT$4,300/月(FastAPI 伺服器)→ Cloudflare Workers+R2+D1 架構約 **NT$1,500/月**(Workers 免費額度大、R2 免流出費,主要剩 Claude API + LINE OA 月費)。

---

## 本週行動清單

- [ ] 把 PhotoFlow 的想法講給 3 個攝影師朋友聽,問願不願意付 NT$299/月
- [ ] 3/3 願意 → 開工;有人猶豫 → 記下他們的「但是」,那就是真規格
- [ ] (可並行)合八字 AI 報告:把 Drive 知識庫的數理/卦象文件整理成 Claude 知識庫
