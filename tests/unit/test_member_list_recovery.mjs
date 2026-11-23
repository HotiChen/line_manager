/**
 * Unit Tests — profile 還在、列表卻沒有他時，follow 必須把人補回列表
 *
 * 症狀：封鎖再解除封鎖之後，「會員管理」看不到自己。
 *
 * 原因：`recordMemberInteraction` 只在「新會員」分支維護 members 列表。
 * 判斷新舊的依據是 profile 讀不讀得到，所以一旦列表與 profile 不同步
 * （清資料只清了列表、回填只補了 profile、或任何一邊寫入失敗），
 * follow 事件會走「現有會員」分支：profile 被更新成 active，
 * 但列表永遠不會再長出這個 id —— 而後台的會員名單是讀列表的。
 *
 * 結果是無法自我修復：再封鎖、再解除、再傳訊息都一樣看不到，
 * 只剩手動打 /member/save 一條路。
 *
 * 列表是純粹的索引，補回去是冪等的，所以兩個分支都該做。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
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

const v1Profile = (owner, member) => `member_profile_${owner}_${member}`;
const v1List = (owner) => `member_list_${owner}`;
const botList = (botId) => `bot:${botId}:members`;

async function load() {
    return import('../../worker_src/lib/event_handler.js');
}

describe('follow 事件要讓會員列表自我修復', () => {
    let env;

    beforeEach(() => {
        env = { KV_LINE_STORAGE: createMockKV() };
        mockLine();
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('profile 存在但列表被清空時，follow 要把他補回列表', async () => {
        // 只留 profile，列表是空的 —— 清資料之後的真實狀態
        await env.KV_LINE_STORAGE.put(v1Profile(OWNER, MEMBER), JSON.stringify({
            memberId: MEMBER, lineName: '王小明', status: 'inactive',
            joinedAt: '2026-01-01T00:00:00.000Z', tags: [], totalInteractions: 3,
        }));
        await env.KV_LINE_STORAGE.put(v1List(OWNER), JSON.stringify([]));

        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        assert.deepEqual(
            await env.KV_LINE_STORAGE.get(v1List(OWNER), { type: 'json' }),
            [MEMBER],
            '舊命名空間的列表沒把人補回來，後台看不到他'
        );
        assert.deepEqual(
            await env.KV_LINE_STORAGE.get(botList(BOT_A), { type: 'json' }),
            [MEMBER],
            'bot 命名空間的列表沒把人補回來'
        );
    });

    it('profile 存在、列表完全不存在時也要補', async () => {
        await env.KV_LINE_STORAGE.put(v1Profile(OWNER, MEMBER), JSON.stringify({
            memberId: MEMBER, lineName: '王小明', status: 'inactive', totalInteractions: 1,
        }));

        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        assert.deepEqual(await env.KV_LINE_STORAGE.get(v1List(OWNER), { type: 'json' }), [MEMBER]);
    });

    it('已經在列表裡的人不會被寫成重複值', async () => {
        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        assert.deepEqual(await env.KV_LINE_STORAGE.get(v1List(OWNER), { type: 'json' }), [MEMBER]);
        assert.deepEqual(await env.KV_LINE_STORAGE.get(botList(BOT_A), { type: 'json' }), [MEMBER]);
    });

    it('列表裡其他人不會被弄掉', async () => {
        const OTHER = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99';
        await env.KV_LINE_STORAGE.put(v1Profile(OWNER, MEMBER), JSON.stringify({
            memberId: MEMBER, lineName: '王小明', status: 'inactive', totalInteractions: 1,
        }));
        await env.KV_LINE_STORAGE.put(v1List(OWNER), JSON.stringify([OTHER]));

        const { handleFollowEvent } = await load();
        await handleFollowEvent(followEvent(), env, OWNER, 'tok', null, BOT_A);

        const list = await env.KV_LINE_STORAGE.get(v1List(OWNER), { type: 'json' });
        assert.deepEqual([...list].sort(), [OTHER, MEMBER].sort());
    });
});
