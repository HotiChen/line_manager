/**
 * Unit Tests — helper/system_form.js（系統管理頁的純邏輯）
 *
 * 規則要與後端 bridge/systems.js 一致，否則使用者在畫面上填得過、送出去才被拒：
 *   - system 代號：/^[a-z0-9][a-z0-9_-]{1,31}$/
 *   - name 必填、≤ 100 字
 *   - scopes 至少一個，且必須是已知的
 * 這個模組不可碰 DOM 或 window，才能在 node 下測。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    SCOPES,
    validateSystemId,
    buildCreatePayload,
    buildCurlExample,
    describeError,
} from '../../helper/system_form.js';

describe('validateSystemId', () => {
    for (const ok of ['imgpicker', 'ab', 'a1', 'my-sys_2', '0abc', 'x'.repeat(32)]) {
        it(`接受 ${ok}`, () => {
            assert.equal(validateSystemId(ok).valid, true);
        });
    }

    for (const bad of ['', 'a', 'A', 'has space', 'a:b', 'a/b', '-ab', '_ab', 'x'.repeat(33), '品棧', null, undefined, 42]) {
        it(`拒絕 ${JSON.stringify(bad)}，並給出訊息`, () => {
            const r = validateSystemId(bad);
            assert.equal(r.valid, false);
            assert.equal(typeof r.message, 'string');
            assert.ok(r.message.length > 0);
        });
    }

    it('前後空白會先去掉', () => {
        assert.equal(validateSystemId('  imgpicker  ').valid, true);
    });

    it('大寫自動轉小寫後視為合法（輸入時不必糾結大小寫）', () => {
        assert.equal(validateSystemId('ImgPicker').valid, true);
    });
});

describe('SCOPES', () => {
    it('raw:push 開放，其餘尚未有對應端點，標示為未開放', () => {
        const byId = Object.fromEntries(SCOPES.map((s) => [s.id, s]));
        assert.equal(byId['raw:push'].available, true);
        assert.equal(byId['members:read'].available, false);
        assert.equal(byId['tags:write'].available, false);
    });

    it('每個 scope 都有給人看的說明', () => {
        for (const s of SCOPES) {
            assert.equal(typeof s.label, 'string');
            assert.ok(s.label.length > 0);
        }
    });
});

describe('buildCreatePayload', () => {
    it('合法輸入 → ok，內容整理過', () => {
        const r = buildCreatePayload({ system: '  ImgPicker ', name: '  Image Picker  ', scopes: ['raw:push'] });
        assert.equal(r.ok, true);
        assert.deepEqual(r.payload, { system: 'imgpicker', name: 'Image Picker', scopes: ['raw:push'] });
    });

    it('代號不合法 → 不 ok，回報欄位', () => {
        const r = buildCreatePayload({ system: 'a:b', name: 'X', scopes: ['raw:push'] });
        assert.equal(r.ok, false);
        assert.equal(r.field, 'system');
    });

    it('名稱空白 → 不 ok', () => {
        const r = buildCreatePayload({ system: 'abc', name: '   ', scopes: ['raw:push'] });
        assert.equal(r.ok, false);
        assert.equal(r.field, 'name');
    });

    it('名稱超過 100 字 → 不 ok', () => {
        const r = buildCreatePayload({ system: 'abc', name: 'x'.repeat(101), scopes: ['raw:push'] });
        assert.equal(r.ok, false);
        assert.equal(r.field, 'name');
    });

    it('沒有勾任何權限 → 不 ok', () => {
        const r = buildCreatePayload({ system: 'abc', name: 'X', scopes: [] });
        assert.equal(r.ok, false);
        assert.equal(r.field, 'scopes');
    });

    it('未知的 scope 不會被送出', () => {
        const r = buildCreatePayload({ system: 'abc', name: 'X', scopes: ['raw:push', 'admin:everything'] });
        assert.equal(r.ok, true);
        assert.deepEqual(r.payload.scopes, ['raw:push']);
    });

    it('只有未知 scope → 不 ok', () => {
        assert.equal(buildCreatePayload({ system: 'abc', name: 'X', scopes: ['admin:everything'] }).ok, false);
    });

    it('scopes 重複會去重', () => {
        const r = buildCreatePayload({ system: 'abc', name: 'X', scopes: ['raw:push', 'raw:push'] });
        assert.deepEqual(r.payload.scopes, ['raw:push']);
    });

    it('欄位缺漏（undefined）不會炸', () => {
        const r = buildCreatePayload({});
        assert.equal(r.ok, false);
    });

    it('不會帶 webhookUrl / events（這兩個功能尚未開放）', () => {
        const r = buildCreatePayload({ system: 'abc', name: 'X', scopes: ['raw:push'], webhookUrl: 'https://x', events: ['a'] });
        assert.equal('webhookUrl' in r.payload, false);
        assert.equal('events' in r.payload, false);
    });
});

describe('buildCurlExample', () => {
    it('帶入網址與 botId，金鑰是 brk_ 形式的佔位符', () => {
        const s = buildCurlExample('https://imhoti.tw/lm', 'Ubot123');
        assert.match(s, /https:\/\/imhoti\.tw\/lm\/bridge\/v1\/raw\/push/);
        assert.match(s, /X-Bot-Id: Ubot123/);
        assert.match(s, /Bearer brk_<PREFIX>_<SECRET>/);
        assert.match(s, /X-Idempotency-Key/);
    });

    it('絕不含真正的 key（brk_ 開頭）', () => {
        assert.doesNotMatch(buildCurlExample('https://x', 'U1'), /brk_[0-9a-f]{6}_[A-Za-z0-9_-]{10,}/);
        assert.doesNotMatch(buildCurlExample('https://x', 'U1'), /sk_[A-Za-z0-9_-]{10,}/);
    });

    it('網址尾端的斜線會去掉，不會變成 //', () => {
        assert.doesNotMatch(buildCurlExample('https://imhoti.tw/lm/', 'U1'), /lm\/\/api/);
    });

    it('沒有 botId 時用佔位符', () => {
        assert.match(buildCurlExample('https://x', ''), /X-Bot-Id: <BOT_ID>/);
        assert.match(buildCurlExample('https://x', null), /X-Bot-Id: <BOT_ID>/);
    });

    it('botId 含奇怪字元時不會破壞 shell 引號', () => {
        const s = buildCurlExample('https://x', 'U1"; rm -rf / #');
        assert.match(s, /X-Bot-Id: <BOT_ID>/);
    });
});

describe('describeError', () => {
    it('403 → 說明只有管理員能用', () => {
        assert.match(describeError(403, {}), /管理員/);
    });

    it('409 → 代號已被註冊', () => {
        assert.match(describeError(409, { error: 'System already registered' }), /已經註冊|已註冊/);
    });

    it('404 → 找不到', () => {
        assert.match(describeError(404, {}), /找不到/);
    });

    it('400 → 帶出後端的說明', () => {
        assert.match(describeError(400, { error: 'name is required (max 100 chars)' }), /name is required/);
    });

    it('401 → 請重新登入', () => {
        assert.match(describeError(401, {}), /登入/);
    });

    it('500 與未知狀態 → 通用訊息，不洩漏細節', () => {
        const m = describeError(500, { error: 'Internal error', stack: 'at secret.js:1' });
        assert.doesNotMatch(m, /stack|secret/);
    });

    it('body 為 null 也不會炸', () => {
        assert.equal(typeof describeError(500, null), 'string');
    });
});
