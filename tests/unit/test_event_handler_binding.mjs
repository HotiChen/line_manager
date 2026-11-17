/**
 * Unit Tests — webhook 事件處理器接上聯絡人綁定（LM-3A：lib/event_handler.js → bridge/binding.js）
 *
 *   - BRIDGE_ENABLED 未開：行為與沒有綁定功能時完全相同（零 D1、關鍵字照常回覆，連「長得像綁定碼」的訊息也照舊）
 *   - 開啟後：1 對 1 聊天室傳來完整綁定碼 → 綁定、回一則確認、不再跑關鍵字
 *   - 群組／聊天室、非文字、不像綁定碼、查無此碼：照原流程（關鍵字）
 *   - D1 壞掉：退回既有流程，不丟錯
 *   - unfollow／follow 更新綁定狀態；D1 壞掉不影響既有的會員處理
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedLink, countingDb, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import * as bdb from '../../worker_src/bridge/db.js';
import { generateBindCode, BIND_CONFIRM_TEXT } from '../../worker_src/bridge/binding.js';
import { handleMessageEvent, handleFollowEvent, handleUnfollowEvent } from '../../worker_src/lib/event_handler.js';

const OWNER = 'Uowner00000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const USER = 'Umember000000000000000000000001';
const LNK = 'lnk_aaaaaaaaaaaaaaaa';
const REF = 'customer-0001';

let d1;
let env;
let sent;
let logs;
const originalFetch = globalThis.fetch;
const originalLog = { error: console.error, warn: console.warn, log: console.log };

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    env = { KV_LINE_STORAGE: createMockKV(), BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1' };
    sent = [];
    logs = [];
    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/v2/profile')) return new Response(JSON.stringify({ displayName: '王小明' }), { status: 200 });
        if (String(url).includes('/message/reply')) sent.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
    };
    const grab = (...a) => logs.push(a.map(String).join(' '));
    console.error = grab; console.warn = grab; console.log = grab;
    await seedLink(d1.db, { linkId: LNK, botId: BOT, key: 'brk_test_a' });
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(console, originalLog);
});

async function issue({ ref = REF, botId = BOT } = {}) {
    const code = generateBindCode();
    await bdb.createBindCode(env, { codeHash: await sha256Hex(code), linkId: LNK, botId, ref, expiresAt: Date.now() + 1e6, now: Date.now() });
    return code;
}

const textEvent = (text, source = { type: 'user', userId: USER }) => ({
    type: 'message', replyToken: 'rt-1', message: { type: 'text', text }, source,
});
const send = (event, e = env, bot = BOT) => handleMessageEvent(event, e, OWNER, 'tok', null, bot);
const contacts = () => all(d1.db, 'SELECT external_contact_ref AS ref, status, line_user_id FROM contacts');

async function seedKeyword(keyword, replyText) {
    await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT), JSON.stringify([{ keyword, replies: [{ type: 'text', text: replyText }] }]));
}

describe('旗標關閉：行為不變', () => {
    it('BRIDGE_ENABLED 未設：零 D1 查詢；綁定碼樣子的文字照走關鍵字；一般關鍵字照常回覆', async () => {
        const code = await issue();
        await seedKeyword(code, 'KEYWORD HIT');
        await seedKeyword('營業時間', '9-18'); // 覆蓋為只有這一個關鍵字
        const c = countingDb(d1.db);
        const off = { ...env, BRIDGE_ENABLED: undefined, BRIDGE_DB: c.db };

        await send(textEvent('營業時間'), off);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].messages[0].text, '9-18');

        await send(textEvent(code), off); // 沒有對應關鍵字 → 沉默，與今天相同
        assert.equal(sent.length, 1);

        await handleUnfollowEvent({ type: 'unfollow', source: { userId: USER } }, off, OWNER, BOT);
        await handleFollowEvent({ type: 'follow', replyToken: 'rt', source: { userId: USER } }, off, OWNER, 'tok', null, BOT);
        assert.equal(c.counter.total, 0, '旗標關閉時不得碰 D1');
        assert.equal(await count(d1.db, 'contacts'), 0);
        assert.equal((await all(d1.db, 'SELECT used_at FROM bind_codes'))[0].used_at, null);
    });

    it('旗標關閉而且根本沒有 BRIDGE_DB binding 也一樣', async () => {
        await seedKeyword('營業時間', '9-18');
        const bare = { KV_LINE_STORAGE: env.KV_LINE_STORAGE };
        await send(textEvent('營業時間'), bare);
        await send(textEvent('LM-23456789'), bare);
        await handleUnfollowEvent({ type: 'unfollow', source: { userId: USER } }, bare, OWNER, BOT);
        assert.equal(sent.length, 1);
    });
});

describe('旗標開啟：綁定碼訊息', () => {
    it('完整綁定碼 → 綁定成功、只回一則確認（不是兩則）、不跑關鍵字', async () => {
        const code = await issue();
        await seedKeyword(code, 'KEYWORD HIT'); // 關鍵字剛好等於碼：綁定優先，關鍵字不得觸發
        await send(textEvent(code));
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0], { replyToken: 'rt-1', messages: [{ type: 'text', text: BIND_CONFIRM_TEXT }] });
        assert.deepEqual(await contacts(), [{ ref: REF, status: 'bound', line_user_id: USER }]);
    });

    it('前後空白與小寫也算；成功消耗的碼與 userId 不進 log', async () => {
        const code = await issue();
        await send(textEvent(`  ${code.toLowerCase()}\n`));
        assert.equal(sent.length, 1);
        assert.equal(sent[0].messages[0].text, BIND_CONFIRM_TEXT);
        const dump = logs.join('\n');
        assert.ok(!dump.toLowerCase().includes(code.toLowerCase()), '碼出現在 log');
        assert.ok(!dump.includes(USER), 'userId 出現在 log');
    });

    it('查無此碼（錯、已用、別的 OA）→ 不回綁定相關訊息，照原流程（關鍵字）', async () => {
        await seedKeyword('LM-23456789', 'KEYWORD HIT');
        await send(textEvent('LM-23456789')); // 長得像、查無此碼 → 沉默地落到關鍵字流程
        assert.equal(sent.length, 1);
        assert.equal(sent[0].messages[0].text, 'KEYWORD HIT');

        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT), JSON.stringify([]));
        sent.length = 0;
        const code = await issue();
        await send(textEvent(code), env, BOT2); // 別的 OA
        await send(textEvent(code));            // 正確的 OA：成功
        await send(textEvent(code));            // 已用：沉默
        assert.deepEqual(sent.map((s) => s.messages[0].text), [BIND_CONFIRM_TEXT]);
    });

    it('不像綁定碼的文字不碰 D1，關鍵字照常', async () => {
        await seedKeyword('營業時間', '9-18');
        const c = countingDb(d1.db);
        const e = { ...env, BRIDGE_DB: c.db };
        await send(textEvent('營業時間'), e);
        await send(textEvent('hello LM-23456789'), e);
        await send(textEvent('LM-1234567'), e);
        assert.equal(c.counter.total, 0);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].messages[0].text, '9-18');
    });

    it('群組、聊天室來源與沒有 userId → 不嘗試綁定（碼不被消耗）', async () => {
        const code = await issue();
        await send(textEvent(code, { type: 'group', groupId: 'G1', userId: USER }));
        await send(textEvent(code, { type: 'room', roomId: 'R1', userId: USER }));
        await send(textEvent(code, { type: 'user' }));
        assert.equal(sent.length, 0);
        assert.equal(await count(d1.db, 'contacts'), 0);
        assert.equal((await all(d1.db, 'SELECT used_at FROM bind_codes'))[0].used_at, null);
    });

    it('非文字訊息仍然早早返回，不碰綁定', async () => {
        const c = countingDb(d1.db);
        await send({ type: 'message', replyToken: 'rt', message: { type: 'sticker' }, source: { type: 'user', userId: USER } }, { ...env, BRIDGE_DB: c.db });
        assert.equal(c.counter.total, 0);
        assert.equal(sent.length, 0);
    });

    it('確認訊息送不出去（LINE 失敗）→ 不丟錯；綁定已完成', async () => {
        const code = await issue();
        globalThis.fetch = async () => new Response('boom', { status: 500 });
        await send(textEvent(code));
        assert.equal((await contacts()).length, 1);
    });

    it('D1 壞掉 → 退回既有關鍵字流程，不丟錯', async () => {
        await seedKeyword('LM-23456789', 'KEYWORD HIT');
        await d1.db.prepare('ALTER TABLE bind_codes RENAME TO bind_codes_hidden').run();
        try {
            await send(textEvent('LM-23456789'));
        } finally {
            await d1.db.prepare('ALTER TABLE bind_codes_hidden RENAME TO bind_codes').run();
        }
        assert.equal(sent.length, 1);
        assert.equal(sent[0].messages[0].text, 'KEYWORD HIT');
    });
});

describe('unfollow / follow', () => {
    async function bound() {
        await send(textEvent(await issue()));
        sent.length = 0;
    }

    it('unfollow → blocked；follow → 還原 bound', async () => {
        await bound();
        await handleUnfollowEvent({ type: 'unfollow', source: { userId: USER } }, env, OWNER, BOT);
        assert.equal((await contacts())[0].status, 'blocked');
        await handleFollowEvent({ type: 'follow', replyToken: 'rt', source: { userId: USER } }, env, OWNER, 'tok', null, BOT);
        assert.equal((await contacts())[0].status, 'bound');
    });

    it('別的 bot 的 unfollow 不影響；沒綁定過的人 follow 不會新建綁定', async () => {
        await bound();
        await handleUnfollowEvent({ type: 'unfollow', source: { userId: USER } }, env, OWNER, BOT2);
        assert.equal((await contacts())[0].status, 'bound');
        await handleFollowEvent({ type: 'follow', replyToken: 'rt', source: { userId: 'Ustranger00000000000000000000001' } }, env, OWNER, 'tok', null, BOT);
        assert.equal(await count(d1.db, 'contacts'), 1);
    });

    it('D1 壞掉：既有的會員 inactive 處理與 follow 流程不受影響、不丟錯', async () => {
        await env.KV_LINE_STORAGE.put(`member_profile_${OWNER}_${USER}`, JSON.stringify({ memberId: USER, status: 'active', tags: [] }));
        await d1.db.prepare('ALTER TABLE contacts RENAME TO contacts_hidden').run();
        try {
            await handleUnfollowEvent({ type: 'unfollow', source: { userId: USER } }, env, OWNER, BOT);
            await handleFollowEvent({ type: 'follow', replyToken: 'rt', source: { userId: USER } }, env, OWNER, 'tok', null, BOT);
        } finally {
            await d1.db.prepare('ALTER TABLE contacts_hidden RENAME TO contacts').run();
        }
        const profile = await env.KV_LINE_STORAGE.get(`member_profile_${OWNER}_${USER}`, { type: 'json' });
        assert.equal(profile.status, 'active'); // follow 之後 recordMemberInteraction 把狀態設回 active
    });
});
