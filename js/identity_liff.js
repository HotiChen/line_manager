/**
 * LIFF 身分頁的腳本（LM-4C）。由 worker_src/bridge/identity.js 回的 HTML 載入（路徑 /bridge/identity/{botId}）。
 *
 * 獨立檔案、不 import 任何模組：頁面的 CSP 只允許同源腳本與 LIFF SDK。
 * 流程：LIFF 登入 → 取得 ID token → 送給 LM（只送 ID token，不送任何從 LIFF 讀到的個人資料）→
 *   - ?verify=1 → POST /bridge/v1/identity/verify，顯示是否通過（負責人設定時用）
 *   - 否則      → POST /bridge/v1/identity/exchange，成功就 location.replace 到 LM 回的導回網址
 * 所有文字只用 textContent；導回網址只接受 https。ID token 與回應都不寫進 console。
 */
(function () {
  'use strict';

  function meta(name) {
    const el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') || '' : '';
  }

  function show(text) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  }

  async function main() {
    const liffId = meta('liff-id');
    const botId = meta('bot-id');
    const apiBase = meta('api-base');
    if (!liffId || !botId || !window.liff) return show('無法載入，請回到 LINE 重新開啟。');

    await window.liff.init({ liffId: liffId });
    if (!window.liff.isLoggedIn()) {
      window.liff.login();
      return;
    }
    const idToken = window.liff.getIDToken();
    if (!idToken) return show('無法取得登入資訊，請回到 LINE 重新開啟。');

    const params = new URLSearchParams(window.location.search);
    if (params.get('verify') === '1') {
      const v = await postJson(apiBase + '/bridge/v1/identity/verify', { bot_id: botId, id_token: idToken });
      if (v.ok) return show('✅ 驗證完成，可以回到後台了。');
      if (v.status === 400) return show('尚未通過：請先加這個官方帳號為好友並傳一則訊息，並確認 LINE Login channel 與官方帳號在同一個 Provider 底下，再重試。');
      return show('驗證失敗，請稍後再試。');
    }

    const body = { bot_id: botId, id_token: idToken, p: params.get('p') || '' };
    const to = params.get('to');
    if (to) body.to = to;
    const state = params.get('s');
    if (state) body.s = state;
    const r = await postJson(apiBase + '/bridge/v1/identity/exchange', body);
    const target = r.ok && r.data && typeof r.data.redirect_to === 'string' ? r.data.redirect_to : '';
    if (target.indexOf('https://') === 0) {
      window.location.replace(target);
      return;
    }
    if (r.status === 429) return show('操作太頻繁，請稍後再試。');
    show('這個功能目前無法使用，請聯絡店家。');
  }

  main().catch(function () { show('發生錯誤，請回到 LINE 重新開啟。'); });
})();
