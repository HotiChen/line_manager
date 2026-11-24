/**
 * Unit Tests — Rich Menu 規則統一（LM-4R）
 *
 *   規則：{ match: { tag } | { segment: "<product_key>:<segment>" }, priority, richMenuId }
 *   - priority 數字愈小愈優先；多條同時符合取最優先
 *   - 沒有符合 → 解除個人選單（回到預設）
 *   - 舊格式 { tag, richMenuId } 不再支援（Tim 2026-11-24：舊的直接廢掉）
 *   - tier 不再切換 Rich Menu
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { openBotStoreFor } from '../../worker_src/lib/bot_store.js';
import {
    resolveRichMenuId, validateRule, syncMemberRichMenu,
} from '../../worker_src/lib/segmented_richmenu_logic.js';
import * as tierSystem from '../../worker_src/lib/tier_system.js';
import { handlePostbackEvent, handleMessageEvent } from '../../worker_src/lib/event_handler.js';

const OWNER = 'Uowner00000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const USER = 'Umember000000000000000000000001';

const tagRule = (tag, priority, richMenuId) => ({ match: { tag }, priority, richMenuId });
const segRule = (segment, priority, richMenuId) => ({ match: { segment }, priority, richMenuId });

// Tim 的目標設定：owner → C、photographer → D、ip:vip → A、預設 → B；C > D > A > B
const TIM_RULES = [
    segRule('ip:vip', 3, 'rm-A'),
    tagRule('photographer', 2, 'rm-D'),
    tagRule('owner', 1, 'rm-C'),
];

describe('resolveRichMenuId', () => {
    it('Tim 的設定：優先順序 C > D > A > 預設', () => {
        assert.equal(resolveRichMenuId(TIM_RULES, { tags: ['owner', 'photographer'], segments: ['ip:vip'] }), 'rm-C');
        assert.equal(resolveRichMenuId(TIM_RULES, { tags: ['photographer'], segments: ['ip:vip'] }), 'rm-D');
        assert.equal(resolveRichMenuId(TIM_RULES, { tags: [], segments: ['ip:vip'] }), 'rm-A');
        assert.equal(resolveRichMenuId(TIM_RULES, { tags: ['other'], segments: [] }), null);
    });

    it('規則順序不影響結果（只看 priority）', () => {
        const reversed = [...TIM_RULES].reverse();
        assert.equal(resolveRichMenuId(reversed, { tags: ['owner', 'photographer'] }), 'rm-C');
    });

    it('priority 相同時，依規則在清單中的順序', () => {
        const rules = [tagRule('a', 1, 'rm-1'), tagRule('b', 1, 'rm-2')];
        assert.equal(resolveRichMenuId(rules, { tags: ['b', 'a'] }), 'rm-1');
    });

    it('分眾必須完全相符（含 product_key）', () => {
        assert.equal(resolveRichMenuId(TIM_RULES, { segments: ['xx:vip'] }), null);
        assert.equal(resolveRichMenuId(TIM_RULES, { segments: ['vip'] }), null);
        assert.equal(resolveRichMenuId(TIM_RULES, { tags: ['ip:vip'] }), null, '標籤不能冒充分眾');
    });

    it('舊格式與壞規則一律忽略', () => {
        const rules = [{ tag: 'VIP', richMenuId: 'rm-old', priority: 1 }, { match: {}, richMenuId: 'x', priority: 1 }, null];
        assert.equal(resolveRichMenuId(rules, { tags: ['VIP'] }), null);
    });

    it('不會改動傳入的規則陣列', () => {
        const rules = [...TIM_RULES];
        resolveRichMenuId(rules, { tags: ['owner'] });
        assert.deepEqual(rules, TIM_RULES);
    });

    it('rules 不是陣列 → null', () => {
        assert.equal(resolveRichMenuId(null, { tags: ['owner'] }), null);
    });
});

describe('validateRule', () => {
    it('合法', () => {
        assert.equal(validateRule(tagRule('VIP', 1, 'richmenu-1')), null);
        assert.equal(validateRule(segRule('ip:vip', 2, 'richmenu-1')), null);
        assert.equal(validateRule(segRule('ip:vip_gold-2', 2, 'richmenu-1')), null);
    });
    it('不合法', () => {
        const bad = [
            { tag: 'VIP', richMenuId: 'r', priority: 1 },             // 舊格式
            { match: {}, richMenuId: 'r', priority: 1 },
            { match: { tag: 'a', segment: 'ip:vip' }, richMenuId: 'r', priority: 1 },
            { match: { tag: '' }, richMenuId: 'r', priority: 1 },
            { match: { tag: 'a' }, richMenuId: '', priority: 1 },
            { match: { tag: 'a' }, richMenuId: 'r', priority: 0 },
            { match: { tag: 'a' }, richMenuId: 'r', priority: 1.5 },
            { match: { tag: 'a' }, richMenuId: 'r' },
            segRule('vip', 1, 'r'),
            segRule('IP:vip', 1, 'r'),
            segRule('ip:VIP', 1, 'r'),
            segRule(`ip:${'a'.repeat(33)}`, 1, 'r'),
            null,
        ];
        for (const r of bad) assert.ok(validateRule(r), `應該不合法: ${JSON.stringify(r)}`);
    });
});

// ---------------------------------------------------------------------------
// 重新計算（呼叫 LINE）
// ---------------------------------------------------------------------------
let env;
let calls;
const originalFetch = globalThis.fetch;
const originalLog = { error: console.error, warn: console.warn, log: console.log };

beforeEach(() => {
    env = { KV_LINE_STORAGE: createMockKV() };
    calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ method: init.method || 'GET', url: String(url) });
        if (String(url).includes('/v2/bot/profile/')) return new Response(JSON.stringify({ displayName: 'x' }), { status: 200 });
        return new Response('{}', { status: 200 });
    };
    console.error = () => {}; console.warn = () => {}; console.log = () => {};
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(console, originalLog);
});

const put = (key, v) => env.KV_LINE_STORAGE.put(key, JSON.stringify(v));
const read = async (key) => JSON.parse(await env.KV_LINE_STORAGE.get(key));
const store = () => openBotStoreFor(env, OWNER, BOT);
const richMenuCalls = () => calls.filter(c => c.url.includes('/richmenu'));

describe('syncMemberRichMenu', () => {
    it('符合 → 連結該選單', async () => {
        await put(BotKeys.segmentedRichMenuRules(BOT), TIM_RULES);
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: ['photographer'] });
        await syncMemberRichMenu(store(), USER, { accessToken: 'tok' });
        assert.deepEqual(richMenuCalls(), [{ method: 'POST', url: `https://api.line.me/v2/bot/user/${USER}/richmenu/rm-D` }]);
    });

    it('傳入的分眾參與比對', async () => {
        await put(BotKeys.segmentedRichMenuRules(BOT), TIM_RULES);
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: [] });
        await syncMemberRichMenu(store(), USER, { accessToken: 'tok', segments: ['ip:vip'] });
        assert.deepEqual(richMenuCalls(), [{ method: 'POST', url: `https://api.line.me/v2/bot/user/${USER}/richmenu/rm-A` }]);
    });

    it('沒有符合 → 解除個人選單（回到預設）', async () => {
        await put(BotKeys.segmentedRichMenuRules(BOT), TIM_RULES);
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: ['other'] });
        await syncMemberRichMenu(store(), USER, { accessToken: 'tok' });
        assert.deepEqual(richMenuCalls(), [{ method: 'DELETE', url: `https://api.line.me/v2/bot/user/${USER}/richmenu` }]);
    });

    it('沒有任何規則 → 不呼叫 LINE（不去動手動設定或 lm:menu 切換的選單）', async () => {
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: ['owner'] });
        await syncMemberRichMenu(store(), USER, { accessToken: 'tok' });
        assert.deepEqual(richMenuCalls(), []);
    });

    it('會員不存在 → 不呼叫 LINE', async () => {
        await put(BotKeys.segmentedRichMenuRules(BOT), TIM_RULES);
        await syncMemberRichMenu(store(), USER, { accessToken: 'tok' });
        assert.deepEqual(richMenuCalls(), []);
    });
});

describe('tier 不再切換 Rich Menu', () => {
    it('tier_system 不再匯出 applyTierRichMenu', () => {
        assert.equal(tierSystem.applyTierRichMenu, undefined);
    });

    it('等級自動升級（即使舊設定開了 benefits.richMenu 且 tier 有 richMenuId）不呼叫 Rich Menu API', async () => {
        await put(BotKeys.tierConfig(BOT), {
            tiers: [{ id: 0, name: 'a', richMenuId: 'rm-old0' }, { id: 1, name: 'b', richMenuId: 'rm-old1' }],
            upgradeRules: { interactions: { enabled: true, rules: [{ tier: 1, interactions: 1 }] }, timeBased: { enabled: false, rules: [] } },
            benefits: { richMenu: { enabled: true } },
        });
        await put(BotKeys.member(BOT, USER), { memberId: USER, tier: 0, totalInteractions: 5, tags: [] });
        const r = await tierSystem.checkTierUpgrade(store(), USER);
        assert.equal(r.upgraded, true);
        assert.deepEqual(richMenuCalls(), []);
    });
});

describe('webhook 的標籤變更會重新計算', () => {
    it('postback tag= 貼標籤後，依規則連結選單', async () => {
        await put(BotKeys.segmentedRichMenuRules(BOT), TIM_RULES);
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: [] });
        await handlePostbackEvent(
            { type: 'postback', replyToken: 'rt', postback: { data: 'tag=owner' }, source: { type: 'user', userId: USER } },
            env, OWNER, 'tok', null, BOT);
        assert.deepEqual((await read(BotKeys.member(BOT, USER))).tags, ['owner']);
        assert.deepEqual(richMenuCalls(), [{ method: 'POST', url: `https://api.line.me/v2/bot/user/${USER}/richmenu/rm-C` }]);
    });

    it('關鍵字自動標籤後，依規則連結選單', async () => {
        await put(BotKeys.segmentedRichMenuRules(BOT), TIM_RULES);
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: [] });
        await put(BotKeys.keywords(BOT), [{ keyword: '我是攝影師', addTags: ['photographer'], replies: [{ type: 'text', text: 'ok' }] }]);
        const pending = [];
        await handleMessageEvent(
            { type: 'message', replyToken: 'rt', message: { type: 'text', text: '我是攝影師' }, source: { type: 'user', userId: USER } },
            env, OWNER, 'tok', { waitUntil: (p) => pending.push(p) }, BOT);
        await Promise.all(pending);
        assert.deepEqual((await read(BotKeys.member(BOT, USER))).tags, ['photographer']);
        assert.ok(richMenuCalls().some(c => c.method === 'POST' && c.url.endsWith('/richmenu/rm-D')));
    });

    it('沒有標籤變更的關鍵字不呼叫 Rich Menu API', async () => {
        await put(BotKeys.segmentedRichMenuRules(BOT), TIM_RULES);
        await put(BotKeys.member(BOT, USER), { memberId: USER, tags: [] });
        await put(BotKeys.keywords(BOT), [{ keyword: 'hi', replies: [{ type: 'text', text: 'ok' }] }]);
        const pending = [];
        await handleMessageEvent(
            { type: 'message', replyToken: 'rt', message: { type: 'text', text: 'hi' }, source: { type: 'user', userId: USER } },
            env, OWNER, 'tok', { waitUntil: (p) => pending.push(p) }, BOT);
        await Promise.all(pending);
        assert.deepEqual(richMenuCalls(), []);
    });
});
