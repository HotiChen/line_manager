/**
 * Unit Tests — helper/link_authorize_form.js（LM-2A-2 同意頁與後台「已連結的產品」的純邏輯）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeScopes, scopeShortLabel, UNKNOWN_SCOPE_TEXT,
  readAuthParams, saveAuthParams, restoreAuthParams, clearAuthParams, resolveAuthParams, AUTH_STORAGE_KEY,
  validateRedirectTarget, parsePreview, buildApprovePayload, describeLinkError, normalizeLinks, formatIsoTime,
  redirectHostLabel, consentNotice, MAX_HOST_DISPLAY, MAX_OA_NAME_DISPLAY,
} from '../../helper/link_authorize_form.js';

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    _m: m,
  };
}
const throwingStorage = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
});

const P = { product_id: 'prd_abcdef123456', state: 'st-1', redirect_uri: 'https://app.example/cb' };
const qs = (o) => `?${new URLSearchParams(o).toString()}`;

describe('scope → 中文', () => {
  it('三個已知 scope 的長版說明', () => {
    const d = describeScopes(['link:manage', 'contacts:bind', 'messages:send']);
    assert.deepEqual(d.items.map((i) => i.text), [
      '管理這個連結（查看狀態、解除、更換金鑰）', '為你的客戶產生綁定碼', '向已綁定的客戶發送通知',
    ]);
    assert.equal(d.canApprove, true);
    assert.equal(d.hasUnknown, false);
  });

  it('未知 scope：顯示「未知權限」、不洩漏原字串、不可同意', () => {
    const d = describeScopes(['link:manage', '<img src=x onerror=alert(1)>']);
    assert.equal(d.hasUnknown, true);
    assert.equal(d.canApprove, false);
    assert.equal(d.items[1].text, UNKNOWN_SCOPE_TEXT);
    assert.equal(JSON.stringify(d).includes('onerror'), false);
  });

  it('raw:push / messages:push 這類系統 scope 在同意頁也視為未知', () => {
    for (const s of ['raw:push', 'messages:push']) {
      assert.equal(describeScopes([s]).canApprove, false);
    }
  });

  it('原型鏈字串（toString、__proto__、constructor）不會被誤認為已知', () => {
    for (const s of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      assert.equal(describeScopes([s]).items[0].known, false, s);
    }
  });

  it('空陣列或非陣列：不可同意', () => {
    assert.equal(describeScopes([]).canApprove, false);
    assert.equal(describeScopes(undefined).canApprove, false);
    assert.equal(describeScopes('link:manage').canApprove, false);
  });

  it('非字串 scope 視為未知', () => {
    assert.equal(describeScopes([1, null, {}]).hasUnknown, true);
  });

  it('後台短標籤', () => {
    assert.equal(scopeShortLabel('link:manage'), '管理連結');
    assert.equal(scopeShortLabel('contacts:bind'), '產生綁定碼');
    assert.equal(scopeShortLabel('messages:send'), '發送通知');
    assert.equal(scopeShortLabel('raw:push'), UNKNOWN_SCOPE_TEXT);
  });
});

describe('readAuthParams', () => {
  it('三個都在才回傳', () => {
    assert.deepEqual(readAuthParams(qs(P)), P);
  });
  it('缺任何一個或空字串都是 null', () => {
    for (const k of Object.keys(P)) {
      const { [k]: _omit, ...rest } = P;
      assert.equal(readAuthParams(qs(rest)), null, `缺 ${k}`);
      assert.equal(readAuthParams(qs({ ...P, [k]: '' })), null, `空 ${k}`);
    }
    assert.equal(readAuthParams(''), null);
    assert.equal(readAuthParams(undefined), null);
  });
  it('redirect_uri 內含 query 時保持原樣', () => {
    const uri = 'https://app.example/cb?x=1&y=2';
    assert.equal(readAuthParams(qs({ ...P, redirect_uri: uri })).redirect_uri, uri);
  });
});

describe('sessionStorage 備援', () => {
  it('保存 → 還原 → 立即清除', () => {
    const st = memStorage();
    assert.equal(saveAuthParams(st, P), true);
    assert.ok(st._m.has(AUTH_STORAGE_KEY));
    assert.deepEqual(restoreAuthParams(st), P);
    assert.equal(st._m.has(AUTH_STORAGE_KEY), false);
    assert.equal(restoreAuthParams(st), null); // 第二次沒有
  });

  it('只存三個欄位，額外欄位丟掉；缺欄位不存', () => {
    const st = memStorage();
    saveAuthParams(st, { ...P, code: 'secret' });
    assert.equal(st._m.get(AUTH_STORAGE_KEY).includes('secret'), false);
    const st2 = memStorage();
    assert.equal(saveAuthParams(st2, { product_id: 'x' }), false);
    assert.equal(st2._m.size, 0);
  });

  it('storage 丟錯（隱私模式）：保存回 false、還原回 null、清除不丟錯', () => {
    const st = throwingStorage();
    assert.equal(saveAuthParams(st, P), false);
    assert.equal(restoreAuthParams(st), null);
    assert.doesNotThrow(() => clearAuthParams(st));
    assert.deepEqual(resolveAuthParams(qs(P), st), P); // 網址有就照用
    assert.equal(resolveAuthParams('', st), null);
  });

  it('沒有 storage（null／undefined）也能運作', () => {
    assert.equal(saveAuthParams(null, P), false);
    assert.equal(restoreAuthParams(undefined), null);
    assert.deepEqual(resolveAuthParams(qs(P), null), P);
    assert.equal(resolveAuthParams('', null), null);
  });

  it('壞資料（不是 JSON、缺欄位、型別錯）一律當沒有，並清掉', () => {
    for (const raw of ['not json', '{"product_id":"x"}', '[]', 'null', JSON.stringify({ ...P, state: 5 })]) {
      const st = memStorage({ [AUTH_STORAGE_KEY]: raw });
      assert.equal(restoreAuthParams(st), null, raw);
      assert.equal(st._m.has(AUTH_STORAGE_KEY), false, raw);
    }
  });

  it('resolve：網址完整就用網址，並清掉舊備援', () => {
    const st = memStorage();
    saveAuthParams(st, { ...P, state: 'old' });
    assert.deepEqual(resolveAuthParams(qs(P), st), P);
    assert.equal(st._m.has(AUTH_STORAGE_KEY), false);
  });

  it('resolve：登入回來網址沒有參數 → 從備援還原並清掉', () => {
    const st = memStorage();
    saveAuthParams(st, P);
    assert.deepEqual(resolveAuthParams('', st), P);
    assert.equal(st._m.has(AUTH_STORAGE_KEY), false);
  });

  it('resolve：網址只有部分參數 → 不拼湊，改用備援（沒有就 null）', () => {
    assert.equal(resolveAuthParams(qs({ product_id: P.product_id }), memStorage()), null);
  });
});

describe('validateRedirectTarget', () => {
  const orig = 'https://app.example/cb';
  const ok = (t, o = orig) => validateRedirectTarget(t, o).ok;

  it('通過：同 origin、同 path，query 保留', () => {
    const r = validateRedirectTarget('https://app.example/cb?code=lmc_abc&state=st-1', orig);
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://app.example/cb?code=lmc_abc&state=st-1');
  });
  it('通過：原 redirect_uri 自己帶 query', () => {
    assert.equal(ok('https://app.example/cb?keep=1&code=c&state=s', 'https://app.example/cb?keep=1'), true);
  });
  it('通過：cancel 的 error=access_denied', () => {
    assert.equal(ok('https://app.example/cb?error=access_denied&state=s'), true);
  });
  it('拒絕 http', () => {
    assert.equal(ok('http://app.example/cb?code=c'), false);
    assert.equal(ok('http://app.example/cb?code=c', 'http://app.example/cb'), false);
  });
  it('拒絕 javascript: 與 data: 與其他協定', () => {
    for (const t of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://app.example/cb', 'blob:https://app.example/x']) {
      assert.equal(ok(t), false, t);
    }
  });
  it('拒絕不同 origin（網域、子網域、埠號）', () => {
    for (const t of ['https://evil.example/cb?code=c', 'https://app.example.evil.example/cb', 'https://sub.app.example/cb', 'https://app.example:8443/cb', 'https://app.example.evil/cb']) {
      assert.equal(ok(t), false, t);
    }
  });
  it('拒絕不同 path（含差一個字元、尾端斜線、大小寫、子路徑、dot-segment）', () => {
    for (const t of ['https://app.example/cb2', 'https://app.example/cb/', 'https://app.example/CB', 'https://app.example/cb/x', 'https://app.example/other/../x', 'https://app.example/']) {
      assert.equal(ok(t), false, t);
    }
  });
  it('拒絕含帳號密碼（userinfo）的網址', () => {
    for (const t of ['https://user:pw@app.example/cb', 'https://user@app.example/cb', 'https://app.example@evil.example/cb', 'https://:pw@app.example/cb']) {
      assert.equal(ok(t), false, t);
    }
  });
  it('原 redirect_uri 含 userinfo 也拒絕', () => {
    assert.equal(ok('https://u@app.example/cb', 'https://u@app.example/cb'), false);
  });
  it('拒絕 fragment', () => {
    assert.equal(ok('https://app.example/cb?code=c#x'), false);
  });
  it('拒絕非法字串、空值、非字串、相對路徑', () => {
    for (const t of ['', 'not a url', '//evil.example/cb', '/cb', 'cb', null, undefined, 42, {}, [], '\u0000https://app.example/cb']) {
      assert.equal(ok(t), false, String(t));
    }
    assert.equal(ok(orig, ''), false);
    assert.equal(ok(orig, 'garbage'), false);
    assert.equal(ok(orig, null), false);
  });
  it('拒絕過長的網址', () => {
    assert.equal(ok(`https://app.example/cb?x=${'a'.repeat(5000)}`), false);
  });
  it('回傳的 url 是解析後的 href（不含原字串的奇怪寫法）', () => {
    const r = validateRedirectTarget('HTTPS://APP.EXAMPLE/cb?code=c', orig);
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://app.example/cb?code=c');
  });
});

describe('parsePreview / buildApprovePayload', () => {
  const good = {
    product: { product_id: 'prd_x', name: 'Image Picker' },
    scopes: ['link:manage'],
    bots: [{ bot_id: 'U1', display_name: '店家 A' }, { bot_id: 'U2', display_name: '' }],
    cancel_redirect_to: 'https://app.example/cb?error=access_denied&state=s',
  };
  it('正常回應', () => {
    const p = parsePreview(good);
    assert.equal(p.productName, 'Image Picker');
    assert.deepEqual(p.bots, [{ botId: 'U1', displayName: '店家 A' }, { botId: 'U2', displayName: 'U2' }]);
    assert.equal(p.cancelRedirectTo, good.cancel_redirect_to);
  });
  it('形狀不對回 null', () => {
    for (const d of [null, undefined, 'x', {}, { ...good, product: {} }, { ...good, scopes: 'a' }, { ...good, bots: null }]) {
      assert.equal(parsePreview(d), null);
    }
  });
  it('壞的 bot 項目被略過；0 bot 仍是有效回應', () => {
    assert.equal(parsePreview({ ...good, bots: [null, {}, { bot_id: 5 }] }).bots.length, 0);
  });
  it('approve payload 只有四個欄位', () => {
    assert.deepEqual(buildApprovePayload(P, 'U1'), { ...P, bot_id: 'U1' });
    assert.deepEqual(Object.keys(buildApprovePayload({ ...P, code: 'x' }, 'U1')).sort(), ['bot_id', 'product_id', 'redirect_uri', 'state']);
  });
});

describe('describeLinkError', () => {
  const body = (code, message = 'server text') => ({ error: { code, message, retryable: false } });
  it('依 code 對照（同意頁）', () => {
    assert.match(describeLinkError(400, body('INVALID_REQUEST')), /連結已失效或參數錯誤，請回到產品重新開始/);
    assert.match(describeLinkError(401, body('INVALID_KEY')), /請重新登入/);
    assert.match(describeLinkError(429, body('RATE_LIMITED')), /請稍後再試/);
    assert.match(describeLinkError(404, body('NOT_FOUND')), /找不到這個官方帳號或你沒有權限|找不到這個官方帳號，或你沒有權限/);
    assert.match(describeLinkError(503, body('INTERNAL')), /服務暫時無法使用/);
    assert.match(describeLinkError(500, body('INTERNAL')), /服務暫時無法使用/);
  });
  it('沒有 code 時看 status', () => {
    assert.match(describeLinkError(503, null), /服務暫時無法使用/);
    assert.match(describeLinkError(502, {}), /服務暫時無法使用/);
    assert.match(describeLinkError(429, null), /請稍後再試/);
  });
  it('其他一律「發生未知錯誤」，而且不回顯後端 message', () => {
    assert.equal(describeLinkError(418, body('WEIRD_CODE', '<script>x</script>')), '發生未知錯誤');
    assert.equal(describeLinkError(400, { error: 'legacy string' }), '發生未知錯誤');
    assert.equal(describeLinkError(400, body('SCOPE_DENIED', 'leak')).includes('leak'), false);
  });
  it('網路失敗（status 0）', () => {
    assert.match(describeLinkError(0, null), /無法連線/);
  });
  it('後台情境的 NOT_FOUND / INVALID_REQUEST 文字不同', () => {
    assert.match(describeLinkError(404, body('NOT_FOUND'), 'admin'), /連結/);
    assert.match(describeLinkError(400, body('INVALID_REQUEST'), 'admin'), /重新整理/);
  });
});

describe('normalizeLinks / formatIsoTime', () => {
  const rows = {
    links: [
      { link_id: 'lnk_a', product_name: '舊的', status: 'revoked', scopes: ['link:manage'], created_at: '2026-01-01T00:00:00.000Z', revoked_at: '2026-02-01T00:00:00.000Z' },
      { link_id: 'lnk_b', product_name: '新的', status: 'active', scopes: ['messages:send'], created_at: '2026-03-01T00:00:00.000Z', revoked_at: null },
      { link_id: 'lnk_c', product_name: '較舊的使用中', status: 'active', scopes: [], created_at: '2026-02-01T00:00:00.000Z', revoked_at: null },
      { link_id: '', status: 'active' }, null, { link_id: 'lnk_d', status: 'weird' },
    ],
  };
  it('壞資料列略過；使用中在前、新到舊', () => {
    assert.deepEqual(normalizeLinks(rows).map((l) => l.linkId), ['lnk_b', 'lnk_c', 'lnk_a']);
  });
  it('沒有名稱給預設；缺 links 回空陣列', () => {
    assert.equal(normalizeLinks({ links: [{ link_id: 'lnk_x', status: 'active' }] })[0].productName, '（未命名產品）');
    assert.deepEqual(normalizeLinks(null), []);
    assert.deepEqual(normalizeLinks({}), []);
  });
  it('產品名稱原樣保留（轉義由 textContent 負責，不在這裡改字）', () => {
    const evil = '<img src=x onerror=alert(1)>';
    assert.equal(normalizeLinks({ links: [{ link_id: 'lnk_x', status: 'active', product_name: evil }] })[0].productName, evil);
  });
  it('時間格式：合法 ISO 有輸出，null／壞字串是 —', () => {
    assert.notEqual(formatIsoTime('2026-03-01T00:00:00.000Z'), '—');
    assert.equal(formatIsoTime(null), '—');
    assert.equal(formatIsoTime('nope'), '—');
    assert.equal(formatIsoTime(123), '—');
  });
});

describe('M-03：同意頁顯示回調主機與授權效果', () => {
  it('redirectHostLabel：只回主機名稱（沒有 scheme、path、query、埠號、帳密）', () => {
    assert.equal(redirectHostLabel('https://app.example.com/cb?x=1#f'), 'app.example.com');
    assert.equal(redirectHostLabel('https://App.Example.COM:443/cb'), 'app.example.com');
    assert.equal(redirectHostLabel('https://app.example.com:8443/cb'), 'app.example.com'); // 埠不顯示（hostname 不含埠）
    assert.equal(redirectHostLabel('https://a.b.c.example.co.jp./cb'), 'a.b.c.example.co.jp.');
  });

  it('IDN／同形字：顯示 URL.hostname 的 punycode 形式（不轉回 Unicode，讓同形字一眼可辨）', () => {
    const host = redirectHostLabel('https://аpple.example/cb'); // 第一個字是西里爾字母 а
    assert.match(host, /^xn--/);
    assert.equal(host, new URL('https://аpple.example/cb').hostname);
    assert.equal(redirectHostLabel('https://例え.jp/cb'), new URL('https://例え.jp/cb').hostname);
    assert.match(redirectHostLabel('https://例え.jp/cb'), /^xn--/);
  });

  it('不是 https、無法解析、含帳號密碼、含空白或控制字元、非字串 → 空字串', () => {
    for (const v of [
      'http://app.example.com/cb', 'javascript:alert(1)', '//app.example.com/cb', '/cb', 'app.example.com', '', null, undefined, 42, {},
      'https://user:pw@app.example.com/cb', 'https://user@app.example.com/cb', ' https://app.example.com/cb', 'https://app.example.com/\ncb', 'https://',
    ]) {
      assert.equal(redirectHostLabel(v), '', JSON.stringify(v));
    }
  });

  it('很長的主機名稱：總長不超過上限，保留「結尾」（真正決定網域歸屬的部分），前面用 … 取代', () => {
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.evil-bank.example`;
    const out = redirectHostLabel(`https://${host}/cb`);
    assert.equal(Array.from(out).length, MAX_HOST_DISPLAY);
    assert.ok(out.startsWith('…'));
    assert.ok(out.endsWith('.evil-bank.example'));
    assert.ok(host.endsWith(out.slice(1)));
    // 剛好等於上限時不截短
    const exact = `${'c'.repeat(MAX_HOST_DISPLAY - 8)}.example`;
    assert.equal(redirectHostLabel(`https://${exact}/cb`), exact);
    // 自訂上限
    assert.equal(redirectHostLabel('https://abcdefghij.example.com/cb', 10), '…ample.com'); // 自訂上限：9 個結尾字元 + …
  });

  it('URL 解析器拒絕的主機（含 <、空白）→ 空字串；其餘特殊字元原樣交給 textContent（不會被當成標記）', () => {
    for (const v of ['https://exa<mple.com/cb', 'https://exa mple.com/cb', 'https://exa>mple.com/cb']) {
      assert.equal(redirectHostLabel(v), '', v);
    }
    assert.equal(typeof redirectHostLabel('https://exa"mple.com/cb'), 'string');
  });

  it('consentNotice：授權後，你的客戶可綁定並收到來自 {OA 名} 的通知', () => {
    assert.equal(consentNotice('我的小店'), '授權後，你的客戶可綁定並收到來自 我的小店 的通知');
    assert.equal(consentNotice('  Shop  '), '授權後，你的客戶可綁定並收到來自 Shop 的通知');
  });

  it('consentNotice：沒有名稱（未選、空白、非字串）時用「所選官方帳號」；超長名稱以 code point 截短，不切壞 emoji', () => {
    for (const v of ['', '   ', undefined, null, 5]) assert.equal(consentNotice(v), '授權後，你的客戶可綁定並收到來自 所選官方帳號 的通知');
    const long = '店'.repeat(100);
    const out = consentNotice(long).replace('授權後，你的客戶可綁定並收到來自 ', '').replace(' 的通知', '');
    assert.equal(Array.from(out).length, MAX_OA_NAME_DISPLAY);
    assert.ok(out.endsWith('…'));
    const emoji = '😀'.repeat(60);
    const o2 = consentNotice(emoji).replace('授權後，你的客戶可綁定並收到來自 ', '').replace(' 的通知', '');
    assert.equal(Array.from(o2).length, MAX_OA_NAME_DISPLAY);
    assert.doesNotMatch(o2, /[\ud800-\udbff](?![\udc00-\udfff])/); // 沒有被切斷的 surrogate
  });
});
