/**
 * Unit Tests — webhook postback 分流（LM-4A：lib/event_handler.js → lib/postback_route.js）
 *
 *   - lm:reply?key=<k>：回關鍵字回覆 <k> 的內容（同一份設定、同一套組訊息）；找不到 → 不回覆，記稽核
 *   - lm:menu?tab=<t>：用 Rich Menu alias 切換；沒有對應 → 不回覆
 *   - px:…：本工單只解析、不轉發、不回覆
 *   - 沒有前綴：tag=／untag= 照舊；其他不回覆
 *   - 格式不合：不回覆，記稽核原因碼
 *   - 任何情況都不再把原始 data 回給客人（拿掉「✅ 已收到您的操作」）
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { handlePostbackEvent } from '../../worker_src/lib/event_handler.js';

const OWNER = 'Uowner00000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const USER = 'Umember000000000000000000000001';

let env;
let replies;   // /message/reply 的 body
let calls;     // 所有 LINE API 呼叫 { method, url }
let logs;
let aliases;   // aliasId → richMenuId
const originalFetch = globalThis.fetch;
const originalLog = { error: console.error, warn: console.warn, log: console.log };

beforeEach(() => {
    env = { KV_LINE_STORAGE: createMockKV() };
    replies = [];
    calls = [];
    logs = [];
    aliases = { wedding: 'richmenu-wedding-0001' };
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({ method: init.method || 'GET', url: u });
        if (u.includes('/v2/bot/profile/')) return new Response(JSON.stringify({ displayName: '王小明' }), { status: 200 });
        if (u.includes('/message/reply')) { replies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
        const m = u.match(/\/richmenu\/alias\/([^/?]+)$/);
        if (m) {
            const id = aliases[decodeURIComponent(m[1])];
            return id
                ? new Response(JSON.stringify({ richMenuAliasId: m[1], richMenuId: id }), { status: 200 })
                : new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
        }
        return new Response('{}', { status: 200 });
    };
    const grab = (...a) => logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.error = grab; console.warn = grab; console.log = grab;
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(console, originalLog);
});

const put = (key, value) => env.KV_LINE_STORAGE.put(key, JSON.stringify(value));
const read = async (key) => JSON.parse(await env.KV_LINE_STORAGE.get(key));
const postback = (data, source = { type: 'user', userId: USER }) => handlePostbackEvent(
    { type: 'postback', replyToken: 'rt-1', postback: { data }, source }, env, OWNER, 'tok', null, BOT);

async function seedKeywords(list) { await put(BotKeys.keywords(BOT), list); }

describe('lm:reply', () => {
    it('命中 → 回該關鍵字的回覆內容，並計入回覆與關鍵字統計', async () => {
        await seedKeywords([
            { keyword: 'hours', replies: [{ type: 'text', text: '每天 9-18' }] },
            { keyword: 'other', replies: [{ type: 'text', text: 'X' }] },
        ]);
        await postback('lm:reply?key=hours');
        assert.equal(replies.length, 1);
        assert.deepEqual(replies[0].messages, [{ type: 'text', text: '每天 9-18' }]);
        assert.equal((await read(BotKeys.messageStats(BOT))).total, 1);
        assert.equal((await read(BotKeys.keywordStats(BOT))).hours.total, 1);
    });

    it('key 比對與打字觸發相同：逗號別名、不分大小寫、中文（URL 編碼）', async () => {
        await seedKeywords([{ keyword: 'Hours,營業時間', replies: [{ type: 'text', text: 'H' }] }]);
        await postback(`lm:reply?key=${encodeURIComponent('營業時間')}`);
        await postback('lm:reply?key=hours');
        assert.equal(replies.length, 2);
    });

    it('重用組訊息程式：變數替換與 Quick Reply 都有', async () => {
        await put(BotKeys.quickReplies(BOT), [
            { id: 'qr1', name: 'q', items: [{ action: { type: 'message', label: 'a', text: 'a' } }] },
        ]);
        await seedKeywords([{ keyword: 'hi', quickReplyId: 'qr1', replies: [{ type: 'text', text: '嗨 (@name)' }] }]);
        await postback('lm:reply?key=hi');
        assert.equal(replies.length, 1);
        const msg = replies[0].messages[0];
        assert.equal(msg.text, '嗨 王小明');
        assert.ok(msg.quickReply && msg.quickReply.items.length === 1, '缺 Quick Reply');
    });

    it('找不到 key → 不回覆、記稽核（不含 userId 與 key 值）', async () => {
        await seedKeywords([{ keyword: 'hours', replies: [{ type: 'text', text: 'H' }] }]);
        await postback('lm:reply?key=nosuchkey');
        assert.equal(replies.length, 0);
        const dump = logs.join('\n');
        assert.match(dump, /POSTBACK_AUDIT.*lm_reply_key_not_found/);
        assert.ok(!dump.includes(USER));
        assert.ok(!dump.includes('nosuchkey'));
    });

    it('沒有任何關鍵字設定 → 不回覆', async () => {
        await postback('lm:reply?key=hours');
        assert.equal(replies.length, 0);
    });

    it('缺 key 參數 → 不回覆、記稽核', async () => {
        await seedKeywords([{ keyword: 'hours', replies: [{ type: 'text', text: 'H' }] }]);
        await postback('lm:reply');
        assert.equal(replies.length, 0);
        assert.match(logs.join('\n'), /POSTBACK_AUDIT.*missing_param/);
    });
});

describe('lm:menu', () => {
    it('alias 存在 → 把該 Rich Menu 連到這位使用者，不回覆', async () => {
        await postback('lm:menu?tab=wedding');
        assert.equal(replies.length, 0);
        assert.ok(calls.some(c => c.method === 'GET' && c.url.endsWith('/v2/bot/richmenu/alias/wedding')));
        assert.ok(calls.some(c => c.method === 'POST' && c.url.endsWith(`/v2/bot/user/${USER}/richmenu/richmenu-wedding-0001`)));
    });

    it('alias 不存在 → 不連結、不回覆、記稽核', async () => {
        await postback('lm:menu?tab=nope');
        assert.equal(replies.length, 0);
        assert.ok(!calls.some(c => c.method === 'POST'));
        assert.match(logs.join('\n'), /POSTBACK_AUDIT.*lm_menu_alias_not_found/);
    });

    it('tab 不是合法的 alias id → 不呼叫 LINE', async () => {
        await postback(`lm:menu?tab=${encodeURIComponent('../x')}`);
        await postback('lm:menu');
        assert.equal(calls.length, 0);
        assert.equal(replies.length, 0);
    });
});

describe('lm: 未知動作、px:', () => {
    it('lm:unknown → 不回覆、記稽核', async () => {
        await postback('lm:dance');
        assert.equal(replies.length, 0);
        assert.match(logs.join('\n'), /POSTBACK_AUDIT.*lm_unknown_action/);
    });

    it('px:ip:plans → 只解析：不轉發、不回覆、不呼叫任何外部服務', async () => {
        await postback('px:ip:plans?type=wedding');
        assert.equal(calls.length, 0);
        assert.match(logs.join('\n'), /POSTBACK_AUDIT.*not_forwarded/);
    });
});

describe('沒有前綴（舊行為）', () => {
    it('tag=／untag= 照舊貼標籤，但不再回覆', async () => {
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: ['Normal'] });
        await postback('tag=VIP&untag=Normal');
        assert.deepEqual((await read(BotKeys.member(BOT, USER))).tags, ['VIP']);
        assert.equal(replies.length, 0);
    });

    it('其他沒有前綴的 data → 不回覆', async () => {
        await postback('action=buy&item=1');
        await postback('x');
        assert.equal(replies.length, 0);
    });
});

describe('格式不合', () => {
    it('超過 300 字元、未知前綴、壞 action → 不回覆、記原因碼', async () => {
        await postback('a'.repeat(301));
        await postback('xx:foo');
        await postback('lm:BAD');
        assert.equal(replies.length, 0);
        const dump = logs.join('\n');
        assert.match(dump, /POSTBACK_AUDIT.*too_long/);
        assert.match(dump, /POSTBACK_AUDIT.*unknown_prefix/);
        assert.match(dump, /POSTBACK_AUDIT.*bad_action/);
    });
});

describe('任何情況都不回原始 data', () => {
    it('回覆與 log 都不含原始 data、也不再出現「已收到您的操作」', async () => {
        await seedKeywords([{ keyword: 'hours', replies: [{ type: 'text', text: '每天 9-18' }] }]);
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: [] });
        const samples = [
            'INTERNAL-zzz-1', 'tag=INTERNAL-zzz-2', 'xx:INTERNAL-zzz-3', 'lm:reply?key=INTERNAL-zzz-4',
            'px:ip:INTERNAL-zzz-5', 'px:ip:plans?t=INTERNAL-zzz-6', `INTERNAL-zzz-7${'a'.repeat(300)}`,
            'lm:menu?tab=INTERNAL-zzz-8', 'lm:reply?key=hours&x=INTERNAL-zzz-9',
        ];
        for (const s of samples) await postback(s);
        const out = JSON.stringify(replies);
        assert.ok(!out.includes('INTERNAL-zzz'), `回覆含原始 data: ${out}`);
        assert.ok(!out.includes('已收到您的操作'));
        assert.ok(!logs.join('\n').includes('INTERNAL-zzz-1'), 'log 含原始 data');
    });
});
