/**
 * Unit Tests — handler/member_demo.js（產生／清除測試會員）
 *
 * 用途：正式站上還沒有會員時，讓 owner 一鍵產生 10 筆假會員看版面，看完一鍵清掉。
 *
 * 安全性質（假資料放在正式 KV，所以「清除」比「產生」更重要）：
 *   - 假會員 ID 以 Udemo 開頭。真實 LINE userId 是 U + 32 位十六進位，
 *     而 m、o 不是十六進位字元，所以真實會員不可能撞到這個前綴
 *   - 清除只刪「前綴符合 且 profile.isDemo === true」的，其餘一律不動
 *   - 只有 owner 能操作
 *   - 不呼叫 LINE API、不同步 Rich Menu（假 ID 打過去只會產生錯誤）
 *   - 重複產生是冪等的（固定 ID，不會越按越多）
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import {
    DEMO_COUNT,
    DEMO_ID_PREFIX,
    buildDemoMembers,
    handleSeedDemoMembers,
    handleClearDemoMembers,
} from '../../worker_src/handler/member_demo.js';
import { route } from '../../worker_src/handler/member.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OWNER = 'Uowner0000000000000000000000001';
const MEMBER_USER = 'Umember000000000000000000000002';
const REAL = 'U0123456789abcdef0123456789abcdef';

const originalFetch = globalThis.fetch;
let env;
let fetchCalls;

const req = () => new Request('https://x/member/demo/seed', { method: 'POST' });

async function seedBot() {
    const kv = env.KV_LINE_STORAGE;
    await kv.put(UserKeys.bots(OWNER), JSON.stringify({ bots: [{ botId: BOT }], currentBotId: BOT }));
    await kv.put(UserKeys.bots(MEMBER_USER), JSON.stringify({ bots: [{ botId: BOT }], currentBotId: BOT }));
    await kv.put(BotKeys.permissions(BOT), JSON.stringify({
        users: [{ userId: OWNER, role: 'owner' }, { userId: MEMBER_USER, role: 'member' }],
    }));
}

const readList = async () => JSON.parse((await env.KV_LINE_STORAGE.get(BotKeys.members(BOT))) || '[]');
const readMember = async (id) => {
    const raw = await env.KV_LINE_STORAGE.get(BotKeys.member(BOT, id));
    return raw ? JSON.parse(raw) : null;
};

beforeEach(async () => {
    env = { KV_LINE_STORAGE: createMockKV() };
    fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; return new Response('{}'); };
    await seedBot();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('buildDemoMembers', () => {
    const list = buildDemoMembers(Date.UTC(2026, 10, 16));

    it(`產生 ${DEMO_COUNT} 筆，ID 固定且不重複`, () => {
        assert.equal(list.length, 10);
        assert.equal(new Set(list.map((m) => m.memberId)).size, 10);
    });

    it('ID 以 Udemo 開頭、長度 33（與 LINE userId 同長）、不含 ":"', () => {
        for (const m of list) {
            assert.ok(m.memberId.startsWith(DEMO_ID_PREFIX));
            assert.equal(m.memberId.length, 33);
            assert.ok(!m.memberId.includes(':'));
        }
    });

    it('ID 不可能是真實 LINE userId（U + 32 位十六進位）', () => {
        for (const m of list) assert.doesNotMatch(m.memberId, /^U[0-9a-f]{32}$/);
    });

    it('每筆都標 isDemo、名字帶 [測試]、備註說明這是測試資料', () => {
        for (const m of list) {
            assert.equal(m.isDemo, true);
            assert.match(m.name, /^\[測試\]/);
            assert.match(m.note, /測試/);
            assert.equal(m.source, 'demo');
        }
    });

    it('欄位形狀與 handleSaveMember 寫的一致（頁面才讀得動）', () => {
        for (const m of list) {
            for (const k of ['memberId', 'status', 'source', 'name', 'lineName', 'pictureUrl', 'phone', 'gender', 'birthday',
                'joinedAt', 'lastInteraction', 'totalInteractions', 'tier', 'tags', 'note', 'temperature', 'temperatureScore']) {
                assert.ok(k in m, `缺少 ${k}`);
            }
            assert.ok(Array.isArray(m.tags));
            assert.equal(typeof m.tier, 'number');
        }
    });

    it('等級與溫度有變化（看得出版面差異）', () => {
        assert.ok(new Set(list.map((m) => m.tier)).size >= 2);
        assert.ok(new Set(list.map((m) => m.temperature)).size >= 2);
    });

    it('不帶標籤（不去動標籤索引）', () => {
        for (const m of list) assert.deepEqual(m.tags, []);
    });

    it('同樣的輸入產生同樣的結果（冪等的前提）', () => {
        assert.deepEqual(buildDemoMembers(1), buildDemoMembers(1));
    });
});

describe('handleSeedDemoMembers', () => {
    it('寫入 10 筆 profile，並加進 members 清單', async () => {
        const res = await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal(res.status, 200);
        assert.equal((await res.json()).created, 10);
        const list = await readList();
        assert.equal(list.length, 10);
        for (const id of list) assert.equal((await readMember(id)).isDemo, true);
    });

    it('重複產生不會變多（冪等）', async () => {
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal((await readList()).length, 10);
    });

    it('不動既有的真實會員，也不重排', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.members(BOT), JSON.stringify([REAL]));
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, REAL), JSON.stringify({ memberId: REAL, name: '真人' }));
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        const list = await readList();
        assert.equal(list[0], REAL);
        assert.equal(list.length, 11);
        assert.equal((await readMember(REAL)).name, '真人');
    });

    it('不呼叫任何外部 API（不碰 LINE）', async () => {
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal(fetchCalls, 0);
    });

    it('KV 操作次數遠低於 Workers 每請求 1000 次的上限', async () => {
        env.KV_LINE_STORAGE._resetOps();
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.ok(env.KV_LINE_STORAGE._ops.total < 100, `ops=${env.KV_LINE_STORAGE._ops.total}`);
    });
});

describe('handleClearDemoMembers', () => {
    it('清掉全部測試會員與清單中的 ID', async () => {
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        const res = await handleClearDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal(res.status, 200);
        assert.equal((await res.json()).removed, 10);
        assert.deepEqual(await readList(), []);
        const leftover = [...env.KV_LINE_STORAGE._store.keys()].filter((k) => k.includes(DEMO_ID_PREFIX));
        assert.deepEqual(leftover, []);
    });

    it('真實會員一筆都不動', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.members(BOT), JSON.stringify([REAL]));
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, REAL), JSON.stringify({ memberId: REAL, name: '真人' }));
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        await handleClearDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.deepEqual(await readList(), [REAL]);
        assert.equal((await readMember(REAL)).name, '真人');
    });

    it('ID 長得像測試會員、但 profile 沒有 isDemo → 不刪（雙重保險）', async () => {
        const lookalike = DEMO_ID_PREFIX + 'x'.repeat(33 - DEMO_ID_PREFIX.length);
        await env.KV_LINE_STORAGE.put(BotKeys.members(BOT), JSON.stringify([lookalike]));
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, lookalike), JSON.stringify({ memberId: lookalike, name: '別人手動建的' }));
        const res = await handleClearDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal((await res.json()).removed, 0);
        assert.deepEqual(await readList(), [lookalike]);
        assert.ok(await readMember(lookalike));
    });

    it('沒有測試會員時回 removed: 0，不寫入', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.members(BOT), JSON.stringify([REAL]));
        env.KV_LINE_STORAGE._resetOps();
        const res = await handleClearDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal((await res.json()).removed, 0);
        assert.equal(env.KV_LINE_STORAGE._ops.put, 0);
        assert.equal(env.KV_LINE_STORAGE._ops.delete, 0);
    });

    it('一次產生、清除再產生，結果一致', async () => {
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        await handleClearDemoMembers(req(), env, OWNER, BOT, 'owner');
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal((await readList()).length, 10);
    });

    it('不呼叫外部 API', async () => {
        await handleSeedDemoMembers(req(), env, OWNER, BOT, 'owner');
        await handleClearDemoMembers(req(), env, OWNER, BOT, 'owner');
        assert.equal(fetchCalls, 0);
    });
});

describe('權限檢查的 bot 與資料寫入的 bot 必須是同一個', () => {
    // 回歸：withPermission 用 X-Bot-Id 驗證 owner，但 handler 曾用「目前所選的 bot」開 store。
    // 一個人是 A 的 owner、卻把 currentBotId 指著只是 member 的 B，就能用 X-Bot-Id: A 通過檢查，
    // 然後對 B 的資料做 seed／clear。
    const BOT_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
    const CROSS = 'Ucross0000000000000000000000007';

    async function seedCross() {
        const kv = env.KV_LINE_STORAGE;
        await kv.put(BotKeys.permissions(BOT), JSON.stringify({ users: [{ userId: CROSS, role: 'owner' }] }));
        await kv.put(BotKeys.permissions(BOT_B), JSON.stringify({ users: [{ userId: CROSS, role: 'member' }] }));
        await kv.put(UserKeys.bots(CROSS), JSON.stringify({ bots: [{ botId: BOT }, { botId: BOT_B }], currentBotId: BOT_B }));
    }
    const call = (path) => route(new Request(`https://x${path}`, { method: 'POST', headers: { 'X-Bot-Id': BOT } }), env, CROSS, path);

    it('X-Bot-Id 指 A（owner）、目前所選是 B（member）：資料寫進 A，B 完全不動', async () => {
        await seedCross();
        const res = await call('/member/demo/seed');
        assert.equal(res.status, 200);
        const inA = JSON.parse((await env.KV_LINE_STORAGE.get(BotKeys.members(BOT))) || '[]');
        const inB = await env.KV_LINE_STORAGE.get(BotKeys.members(BOT_B));
        assert.equal(inA.length, 10);
        assert.equal(inB, null);
        const leaked = [...env.KV_LINE_STORAGE._store.keys()].filter((k) => k.startsWith(`bot:${BOT_B}:member`));
        assert.deepEqual(leaked, []);
    });

    it('清除同樣只作用在通過權限檢查的那個 bot', async () => {
        await seedCross();
        // B 裡有一筆測試會員（別人建的），不可被 CROSS 清掉
        const demoId = DEMO_ID_PREFIX + '0'.repeat(27) + '9';
        await env.KV_LINE_STORAGE.put(BotKeys.members(BOT_B), JSON.stringify([demoId]));
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT_B, demoId), JSON.stringify({ memberId: demoId, isDemo: true }));
        await call('/member/demo/clear');
        assert.deepEqual(JSON.parse(await env.KV_LINE_STORAGE.get(BotKeys.members(BOT_B))), [demoId]);
        assert.ok(await env.KV_LINE_STORAGE.get(BotKeys.member(BOT_B, demoId)));
    });
});

describe('路由與權限', () => {
    const call = (userId, path) =>
        route(new Request(`https://x${path}`, { method: 'POST', headers: { 'X-Bot-Id': BOT } }), env, userId, path);

    it('owner 可以產生與清除', async () => {
        assert.equal((await call(OWNER, '/member/demo/seed')).status, 200);
        assert.equal((await readList()).length, 10);
        assert.equal((await call(OWNER, '/member/demo/clear')).status, 200);
        assert.equal((await readList()).length, 0);
    });

    it('member 角色不可以 → 403，且沒有寫入任何資料', async () => {
        const before = env.KV_LINE_STORAGE._store.size;
        assert.equal((await call(MEMBER_USER, '/member/demo/seed')).status, 403);
        assert.equal((await call(MEMBER_USER, '/member/demo/clear')).status, 403);
        assert.equal(env.KV_LINE_STORAGE._store.size, before);
    });

    it('不在這個 bot 的人 → 403', async () => {
        assert.equal((await call('Ustranger000000000000000000000009', '/member/demo/seed')).status, 403);
    });

    it('只接受 POST', async () => {
        const r = await route(new Request('https://x/member/demo/seed', { method: 'GET', headers: { 'X-Bot-Id': BOT } }), env, OWNER, '/member/demo/seed');
        assert.equal(r.status, 405);
    });

    it('既有的 /member/list 不受影響', async () => {
        await call(OWNER, '/member/demo/seed');
        const res = await route(new Request('https://x/member/list'), env, OWNER, '/member/list');
        assert.equal((await res.json()).data.length, 10);
    });
});
