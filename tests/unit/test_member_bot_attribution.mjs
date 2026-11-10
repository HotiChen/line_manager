/**
 * Unit Tests — 會員要記得自己屬於哪個 bot
 *
 * 問題：會員資料的 key 是 member_profile_${ownerId}_${lineUserId} —— 綁 owner，
 * 不綁 bot。而寫入時完全沒記來源帳號，所以同一個 owner 底下兩個官方帳號的
 * 會員會混在一起，事後分不回去。正式環境已經有一個 owner 有兩個帳號，他的
 * 會員現在就是這個狀態。
 *
 * 這是唯一一件「今天不做，明天成本更高」的事：每個新加入的好友都在增加一筆
 * 不可歸屬的資料。先把欄位補上，債就停止長大；將來做 botId 統一時，只有
 * 今天之前的舊資料需要猜。
 *
 * 為什麼是陣列而不是單一欄位：profile key 綁 owner，所以同一個人追蹤同一個
 * owner 的兩個帳號時只有一筆記錄，單一欄位記不下兩個。記成 botIds 陣列，
 * migration 才能把他複製到兩邊的命名空間，而不是二選一。
 *
 * botId 就是 LINE 的 destination，webhook.js 收到請求時就在手上。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMockKV } from '../helpers/mock_kv.mjs';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const MEMBER = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';

const originalFetch = globalThis.fetch;

function mockLine() {
    globalThis.fetch = async (url) => {
        if (String(url).includes('/v2/profile')) {
            return new Response(JSON.stringify({ userId: MEMBER, displayName: '王小明' }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    };
}

function followEvent() {
    return { type: 'follow', replyToken: 'rt1', source: { userId: MEMBER } };
}

function profileKey(owner, member) {
    return `member_profile_${owner}_${member}`;
}

async function load() {
    return import('../../worker_src/lib/event_handler.js');
}

describe('follow 事件寫入會員時要記下 botId', () => {
    let env;

    beforeEach(() => {
        env = { KV_LINE_STORAGE: createMockKV() };
        mockLine();
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('新會員的 botIds 是追蹤的那個 bot', async () => {
        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        const profile = await env.KV_LINE_STORAGE.get(profileKey(OWNER, MEMBER), { type: 'json' });
        assert.ok(profile, '會員沒被建立');
        assert.deepEqual(profile.botIds, [BOT_A]);
    });

    it('既有會員沒有 botIds 時補上（讓舊資料逐步可歸屬）', async () => {
        const { handleFollowEvent } = await load();
        await env.KV_LINE_STORAGE.put(profileKey(OWNER, MEMBER), JSON.stringify({
            memberId: MEMBER, lineName: '舊資料', status: 'inactive',
            joinedAt: '2026-01-01T00:00:00.000Z', tags: ['vip'], totalInteractions: 7,
        }));

        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        const profile = await env.KV_LINE_STORAGE.get(profileKey(OWNER, MEMBER), { type: 'json' });
        assert.deepEqual(profile.botIds, [BOT_A]);
    });

    it('同一個人追蹤第二個 bot 時兩個都記住', async () => {
        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_B);

        const profile = await env.KV_LINE_STORAGE.get(profileKey(OWNER, MEMBER), { type: 'json' });
        assert.deepEqual([...profile.botIds].sort(), [BOT_A, BOT_B].sort());
    });

    it('重複追蹤同一個 bot 不會寫入重複值', async () => {
        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        const profile = await env.KV_LINE_STORAGE.get(profileKey(OWNER, MEMBER), { type: 'json' });
        assert.deepEqual(profile.botIds, [BOT_A]);
    });

    it('既有會員的其他欄位不可被覆蓋', async () => {
        const { handleFollowEvent } = await load();
        await env.KV_LINE_STORAGE.put(profileKey(OWNER, MEMBER), JSON.stringify({
            memberId: MEMBER, lineName: '原本的名字', status: 'inactive',
            joinedAt: '2026-01-01T00:00:00.000Z', tags: ['vip', '婚紗'], totalInteractions: 7,
        }));

        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        const profile = await env.KV_LINE_STORAGE.get(profileKey(OWNER, MEMBER), { type: 'json' });
        assert.deepEqual(profile.tags, ['vip', '婚紗']);
        assert.equal(profile.joinedAt, '2026-01-01T00:00:00.000Z');
        assert.equal(profile.totalInteractions, 8, 'totalInteractions 應該 +1');
        assert.equal(profile.status, 'active');
    });

    it('沒有 botId 可用時照常建立會員，但不寫入垃圾值', async () => {
        // destination 缺失（理論上 webhook 已經擋掉，但這層不該因此崩潰）
        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, undefined);

        const profile = await env.KV_LINE_STORAGE.get(profileKey(OWNER, MEMBER), { type: 'json' });
        assert.ok(profile, '會員應該還是要被建立');
        assert.ok(!('botIds' in profile) || profile.botIds.length === 0,
            `不該寫入垃圾 botIds：${JSON.stringify(profile.botIds)}`);
    });

    it('botId 含分隔符時視為無效，不可寫入', async () => {
        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, 'U1:evil');

        const profile = await env.KV_LINE_STORAGE.get(profileKey(OWNER, MEMBER), { type: 'json' });
        assert.ok(!profile.botIds || !profile.botIds.includes('U1:evil'));
    });

    it('會員列表照舊維護', async () => {
        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        const list = await env.KV_LINE_STORAGE.get(`member_list_${OWNER}`, { type: 'json' });
        assert.deepEqual(list, [MEMBER]);
    });
});

describe('webhook 必須真的把 destination 傳下去', () => {
    // 上面那組測試只證明 event_handler 會用 botId。如果 webhook 沒把
    // destination 傳進去，整個功能在正式環境就是不會執行 —— 這組守的是那條線。
    const SECRET = 'test-channel-secret';

    function signedRequest(bodyText) {
        const signature = createHmac('sha256', SECRET).update(bodyText, 'utf8').digest('base64');
        return new Request('https://example.com/api/webhook', {
            method: 'POST',
            headers: new Headers({ 'x-line-signature': signature, 'Content-Type': 'application/json' }),
            body: bodyText,
        });
    }

    it('真實的 follow webhook 走完之後，會員帶著正確的 botIds', async () => {
        mockLine();
        try {
            const kv = createMockKV();
            await kv.put(`destination_user_${BOT_A}`, OWNER);
            await kv.put(`access_tokens_${OWNER}`, JSON.stringify({
                '品禔': { token: 'channel-token', destination: BOT_A, displayName: '品禔' },
            }));
            const env = { KV_LINE_STORAGE: kv, LINE_CHANNEL_SECRET: SECRET };

            const bodyText = JSON.stringify({
                destination: BOT_A,
                events: [{ type: 'follow', replyToken: 'rt1', source: { userId: MEMBER } }],
            });

            const pending = [];
            const ctx = { waitUntil: (p) => pending.push(p) };

            const { handleWebhookRequest } = await import('../../worker_src/handler/webhook.js');
            const res = await handleWebhookRequest(signedRequest(bodyText), env, ctx);
            assert.equal(res.status, 200);
            await Promise.all(pending);

            const profile = await kv.get(profileKey(OWNER, MEMBER), { type: 'json' });
            assert.ok(profile, '會員沒被建立 —— webhook 沒走到 recordMemberInteraction');
            assert.deepEqual(profile.botIds, [BOT_A],
                'webhook 沒把 destination 傳下去，botIds 是空的');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
