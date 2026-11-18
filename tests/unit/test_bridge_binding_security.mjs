/**
 * Unit Tests — M-02：綁定碼的猜測防護與覆蓋既有綁定（bridge/binding.js + bridge/db.js + POST /contacts/bind-tokens，真 D1）
 *
 *   D4  新碼 LM-XXXX-XXXX-XXXX（12 碼）、48 小時；舊 8 碼在過渡期仍可消耗
 *   D5  每 (bot, 使用者) 每分鐘 10 次；每 bot 每分鐘 30 次「查無此碼」→ 暫停 5 分鐘（不查碼）＋稽核 bind_paused（每小時一次）
 *   D6  覆蓋既有綁定預設拒絕（碼不被消耗、沉默、稽核 bind_rejected）；allow_rebind 才覆蓋並通知原綁定者；同人重綁冪等
 *   缺 0004 遷移 → 不綁定、發碼 503；隱私：計數鍵／旗標／稽核／log 不含碼、ref、LINE userId
 * 沒有任何 sleep：並行用 Promise.all；時間用 Date.now 釘住。
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { withPinnedWindow } from '../helpers/pin_time.mjs';
import { seedLink, countingDb, all, count } from '../helpers/bridge_seed.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import * as bdb from '../../worker_src/bridge/db.js';
import { handleBridge } from '../../worker_src/bridge/index.js';
import {
    generateBindCode, formatBindCode, tryConsumeBindCode, BIND_CODE_TTL_MS, BIND_CONFIRM_TEXT, REBIND_NOTICE_TEXT,
    USER_ATTEMPT_CAP, BOT_FAILURE_CAP, BIND_PAUSE_MS,
} from '../../worker_src/bridge/binding.js';

const OWNER = 'Uowner0000000000000000000000001';
const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const LNK = 'lnk_aaaaaaaaaaaaaaaa';
const LNK2 = 'lnk_bbbbbbbbbbbbbbbb';
const PRD = 'prd_aaaaaaaaaaaa';
const PRD2 = 'prd_bbbbbbbbbbbb';
const KEY_A = 'brk_aaaaaa_link-key-for-a-0000000000000000000000';
const USER = 'Uuser00000000000000000000000001';
const USER2 = 'Uuser00000000000000000000000002';
const USER3 = 'Uuser00000000000000000000000003';
const REF = 'customer-0001';
const REF2 = 'customer-0002';
const LINE_TOKEN = 'TOKEN_SECRET_VALUE_X';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const MIN = 60_000;
const HOUR = 3_600_000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let d1;
let env;
let kv;
let logs;
let pushes;
let pushImpl;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const consoleMethods = ['error', 'warn', 'log', 'info'];
const originalConsole = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    kv = createMockKV();
    env = { BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', KV_LINE_STORAGE: kv };
    logs = [];
    for (const m of consoleMethods) console[m] = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
    pushes = [];
    pushImpl = () => new Response('{}', { status: 200 });
    globalThis.fetch = async (url, init) => {
        if (String(url) === PUSH_URL) {
            pushes.push({ to: JSON.parse(init.body).to, messages: JSON.parse(init.body).messages, auth: init.headers.Authorization });
            return pushImpl();
        }
        if (String(url).endsWith('/v2/bot/info')) return new Response(JSON.stringify({ basicId: '@123abcde' }), { status: 200 });
        throw new Error(`unexpected fetch ${url}`);
    };
    await kv.put(BotKeys.owner(BOT), OWNER);
    await kv.put(`access_tokens_${OWNER}`, JSON.stringify({ main: { token: LINE_TOKEN, destination: BOT } }));
    await seedLink(d1.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY_A });
});
afterEach(() => {
    for (const m of consoleMethods) console[m] = originalConsole[m];
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
});

const withNow = async (ms, fn) => { Date.now = () => ms; try { return await fn(); } finally { Date.now = originalNow; } };
const userOf = (i) => `Uguess${String(i).padStart(27, '0')}`;
const refOf = (i) => `customer-${String(i + 100).padStart(4, '0')}`;
const wrong = (i = 0) => `LM-${'2345'.repeat(3).slice(0, 12 - 2)}${String(i % 100).padStart(2, '0').replace(/[01]/g, 'A')}`; // 一定長得像碼、但不存在
const bindText = (text, { botId = BOT, userId = USER, e = env } = {}) => tryConsumeBindCode(e, { botId, lineUserId: userId, text });
const contactRows = () => all(d1.db, 'SELECT link_id, external_contact_ref AS ref, line_user_id, status FROM contacts ORDER BY external_contact_ref');
const codeRows = () => all(d1.db, 'SELECT used_at, allow_rebind FROM bind_codes');

async function issue({ linkId = LNK, botId = BOT, ref = REF, now = Date.now(), allowRebind = false, ttl = BIND_CODE_TTL_MS } = {}) {
    const code = generateBindCode();
    assert.deepEqual(await bdb.createBindCode(env, { codeHash: await sha256Hex(code), linkId, botId, ref, expiresAt: now + ttl, allowRebind, now }), { created: true });
    return code;
}

/** 舊格式：LM- + 8 碼（M-02 之前發出的碼）。直接寫 SQL，不經過現在的產生器 */
async function issueLegacy({ ref = REF, now = Date.now(), ttl = 7 * 24 * HOUR } = {}) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = `LM-${Array.from(bytes, (b) => ALPHABET[b & 31]).join('')}`;
    await d1.db.prepare(
        'INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(await sha256Hex(code), LNK, BOT, ref, now, now + ttl).run();
    return code;
}

describe('D4：新碼格式與舊碼相容', () => {
    it('TTL 是 48 小時', () => {
        assert.equal(BIND_CODE_TTL_MS, 48 * HOUR);
    });

    it('新碼：有連字號、無連字號、小寫、前後空白，都能綁定（同一組碼只有第一次有效）', async () => {
        const forms = [(c) => formatBindCode(c), (c) => c, (c) => formatBindCode(c).toLowerCase(), (c) => c.toLowerCase().replace('lm-', 'lm-'), (c) => `  ${formatBindCode(c)}\n`];
        for (let i = 0; i < forms.length; i++) {
            const code = await issue({ ref: refOf(i) });
            const r = await bindText(forms[i](code), { userId: userOf(i) });
            assert.deepEqual(r, { handled: true, replyText: BIND_CONFIRM_TEXT }, forms[i](code));
            assert.deepEqual(await bindText(formatBindCode(code), { userId: userOf(i) }), { handled: false });
        }
        assert.equal(await count(d1.db, 'contacts'), forms.length);
    });

    it('資料庫存的是「無連字號標準形」的雜湊：連字號形式與無連字號形式雜湊到同一列', async () => {
        const code = await issue();
        const rows = await all(d1.db, 'SELECT code_hash FROM bind_codes');
        assert.equal(rows[0].code_hash, await sha256Hex(code));
        assert.doesNotMatch(code, /-.*-/); // 標準形只有 LM- 後的那一個連字號
    });

    it('近似的新碼（少一碼、多一碼、換一碼）不會綁定，也不會燒掉真的碼', async () => {
        const code = await issue();
        const shown = formatBindCode(code);
        const flip = shown.slice(0, -1) + (shown.endsWith('A') ? 'B' : 'A');
        for (const t of [shown.slice(0, -1), `${shown}A`, flip, shown.replace('LM-', 'LN-'), `請綁定 ${shown}`]) {
            assert.deepEqual(await bindText(t), { handled: false }, t);
        }
        assert.equal((await codeRows())[0].used_at, null);
        assert.equal((await bindText(shown)).handled, true);
    });

    it('舊 8 碼：過渡期內（尚未過期）仍可消耗；過期的不行；大小寫與空白同樣不影響', async () => {
        const legacy = await issueLegacy({ ref: REF });
        assert.deepEqual(await bindText(`  ${legacy.toLowerCase()} `), { handled: true, replyText: BIND_CONFIRM_TEXT });
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, line_user_id: USER, status: 'bound' }]);
        assert.deepEqual(await bindText(legacy), { handled: false }); // 只能用一次

        const expired = await issueLegacy({ ref: REF2, now: Date.now() - 8 * 24 * HOUR, ttl: 7 * 24 * HOUR });
        assert.deepEqual(await bindText(expired, { userId: USER2 }), { handled: false });
        const nearEnd = await issueLegacy({ ref: 'customer-0003', now: Date.now() - 7 * 24 * HOUR + HOUR, ttl: 7 * 24 * HOUR });
        assert.equal((await bindText(nearEnd, { userId: USER2 })).handled, true);
    });

    it('舊碼被別人佔用的 ref 同樣受 D6 保護（預設不許覆蓋，因為 allow_rebind 欄位預設 0）', async () => {
        await bindText(await issue());
        const legacy = await issueLegacy({ ref: REF });
        assert.deepEqual(await bindText(legacy, { userId: USER2 }), { handled: false });
        assert.equal((await contactRows())[0].line_user_id, USER);
        assert.equal((await codeRows()).find((r) => r.used_at === null) !== undefined, true);
    });
});

describe('D5：每 (bot, 使用者) 與每 bot 的嘗試上限（D1 原子計數）', () => {
    it('每 (bot, 使用者) 每分鐘 10 次（只有「長得像碼」的訊息計次）；超過後連正確的碼也不處理；下一分鐘重置', async () => {
        const base = Math.floor(originalNow() / MIN) * MIN;
        await withNow(base + 20_000, async () => {
            const code = await issue();
            for (let i = 0; i < USER_ATTEMPT_CAP; i++) assert.deepEqual(await bindText(wrong(i)), { handled: false });
            await bindText('你好'); // 不像碼：不計次
            assert.deepEqual(await bindText(code), { handled: false });
            assert.equal(await count(d1.db, 'contacts'), 0);
            assert.equal((await bindText(code, { userId: USER2 })).handled, true); // 另一個使用者有自己的桶
        });
        await withNow(base + MIN, async () => {
            assert.equal(USER_ATTEMPT_CAP, 10);
            const code = await issue({ ref: REF2 });
            assert.equal((await bindText(code)).handled, true);
        });
    });

    it('同一使用者在別的 bot 有自己的桶', async () => {
        await seedLink(d1.db, { linkId: LNK2, productId: PRD2, botId: BOT2, key: 'brk_test_b' });
        await withPinnedWindow(async () => {
            for (let i = 0; i < USER_ATTEMPT_CAP + 2; i++) await bindText(wrong(i));
            const code = await issue({ linkId: LNK2, botId: BOT2 });
            assert.equal((await bindText(code, { botId: BOT2 })).handled, true);
        });
    });

    it('計數鍵不含 LINE userId 明文（只有雜湊前 32 碼）', async () => {
        await withPinnedWindow(async () => { await bindText(wrong(1)); });
        const keys = (await all(d1.db, 'SELECT scope_key FROM counters')).map((r) => r.scope_key);
        assert.ok(keys.some((k) => /^binduser:U[b0-9a-z]+:[0-9a-f]{32}$/.test(k)), keys.join(','));
        assert.ok(keys.some((k) => k === `bindfail:${BOT}`));
        assert.ok(keys.every((k) => !k.includes(USER)));
        assert.ok(keys.find((k) => k.startsWith('binduser:')).endsWith((await sha256Hex(USER)).slice(0, 32)));
    });

    it('每 bot 每分鐘 30 次「查無此碼」：第 31 次起暫停 5 分鐘，暫停期間連正確的碼也不處理、而且不查碼', async () => {
        const base = Math.floor(originalNow() / MIN) * MIN;
        const code = await issue();
        await withNow(base + 10_000, async () => {
            for (let i = 0; i < BOT_FAILURE_CAP; i++) assert.deepEqual(await bindText(wrong(i), { userId: userOf(i) }), { handled: false });
            assert.equal(await bdb.getFlag(env, { key: `bindpause:${BOT}` }), false, '剛好 30 次還沒暫停');
            assert.deepEqual(await bindText(wrong(31), { userId: userOf(31) }), { handled: false }); // 第 31 次
            assert.equal(await bdb.getFlag(env, { key: `bindpause:${BOT}` }), true);

            // 暫停期間：正確的碼不處理，且 SQL 只碰 flags（沒有任何 bind_codes／contacts／counters 查詢）
            const sqls = [];
            const spy = { prepare: (sql) => { sqls.push(sql); return d1.db.prepare(sql); }, batch: (b) => { sqls.push('BATCH'); return d1.db.batch(b); } };
            assert.deepEqual(await bindText(code, { userId: USER2, e: { ...env, BRIDGE_DB: spy } }), { handled: false });
            assert.equal(sqls.length, 1, sqls.join('\n'));
            assert.match(sqls[0], /FROM flags/);
            assert.equal((await codeRows())[0].used_at, null);
        });
        // 5 分鐘內仍暫停；過了就恢復，那組碼仍然有效
        await withNow(base + 10_000 + BIND_PAUSE_MS - 1, async () => {
            assert.deepEqual(await bindText(code, { userId: USER2 }), { handled: false });
        });
        await withNow(base + 10_000 + BIND_PAUSE_MS + 1, async () => {
            assert.equal(BIND_PAUSE_MS, 5 * MIN);
            assert.equal((await bindText(code, { userId: USER2 })).handled, true);
        });
    });

    it('暫停只影響該 bot：另一個 bot 的綁定照常；已綁定者的 follow／unfollow 不受影響', async () => {
        await seedLink(d1.db, { linkId: LNK2, productId: PRD2, botId: BOT2, key: 'brk_test_b' });
        await withPinnedWindow(async () => {
            for (let i = 0; i <= BOT_FAILURE_CAP; i++) await bindText(wrong(i), { userId: userOf(i) });
            assert.equal(await bdb.getFlag(env, { key: `bindpause:${BOT}` }), true);
            const code2 = await issue({ linkId: LNK2, botId: BOT2 });
            assert.equal((await bindText(code2, { botId: BOT2 })).handled, true);
        });
    });

    it('bind_paused 稽核：每 bot 每小時一次（只有 bot，沒有碼／userId／ref）；下一小時可再寫', async () => {
        const hourStart = Math.floor(originalNow() / HOUR) * HOUR;
        const trip = async (offset) => withNow(hourStart + offset, async () => {
            for (let i = 0; i <= BOT_FAILURE_CAP + 3; i++) await bindText(wrong(i), { userId: userOf(i) });
        });
        await trip(10 * MIN);
        let rows = await all(d1.db, "SELECT * FROM audit_log WHERE action = 'bind_paused'");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].bot_id, BOT);
        assert.equal(rows[0].actor_type, 'system');
        assert.equal(rows[0].detail, null);
        // 同一小時內暫停結束後再爆一次：不重複寫
        await trip(17 * MIN); // 第一次暫停（到第 15 分鐘）已結束
        rows = await all(d1.db, "SELECT * FROM audit_log WHERE action = 'bind_paused'");
        assert.equal(rows.length, 1);
        await trip(HOUR + 10 * MIN);
        rows = await all(d1.db, "SELECT * FROM audit_log WHERE action = 'bind_paused'");
        assert.equal(rows.length, 2);
    });

    it('正常綁定不吃每 bot 的「查無此碼」預算：40 個人各綁一個 ref 都成功，不會暫停', async () => {
        await withPinnedWindow(async () => {
            const codes = [];
            for (let i = 0; i < 40; i++) codes.push(await issue({ ref: refOf(i) }));
            for (let i = 0; i < 40; i++) assert.equal((await bindText(codes[i], { userId: userOf(i) })).handled, true, `第 ${i} 個`);
            assert.equal(await bdb.getFlag(env, { key: `bindpause:${BOT}` }), false);
            assert.equal(await count(d1.db, 'contacts'), 40);
            assert.equal((await all(d1.db, 'SELECT n FROM counters WHERE scope_key = ?1', `bindfail:${BOT}`))[0].n, 0);
        });
    });

    it('並行猜碼：50 個不同使用者同時猜錯，實際查碼的次數不超過每 bot 預算 30，之後暫停', async () => {
        const realRandom = Math.random;
        Math.random = () => 0.5; // 不要在中途觸發機率性清理（它也是 batch）
        try {
            await withPinnedWindow(async () => {
                const spy = countingDb(d1.db);
                const e = { ...env, BRIDGE_DB: spy.db };
                const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => bindText(wrong(i), { userId: userOf(i), e })));
                assert.ok(rs.every((r) => r.handled === false));
                assert.equal(spy.counter.batch, BOT_FAILURE_CAP, `查碼（每次一個 batch）的次數：${spy.counter.batch}`);
                assert.equal(await bdb.getFlag(env, { key: `bindpause:${BOT}` }), true);
                assert.equal(await count(d1.db, 'audit_log', "action = 'bind_paused'"), 1);
            });
        } finally {
            Math.random = realRandom;
        }
    });
});

describe('D6：覆蓋既有綁定預設拒絕', () => {
    it('另一位 LINE 使用者用（預設）新碼想綁已被綁定的 ref → 不覆蓋、沉默、碼不被消耗、稽核 bind_rejected', async () => {
        await bindText(await issue());
        const code2 = await issue();
        const r = await bindText(code2, { userId: USER2 });
        assert.deepEqual(r, { handled: false }); // 沉默：照原流程走，與「查無此碼」看起來一樣
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, line_user_id: USER, status: 'bound' }]);
        assert.equal((await codeRows()).filter((c) => c.used_at === null).length, 1, '碼沒有被燒掉');
        assert.equal(pushes.length, 0, '沒有任何 LINE 訊息');
        const rows = await all(d1.db, "SELECT * FROM audit_log WHERE action = 'bind_rejected'");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].bot_id, BOT);
        assert.equal(rows[0].result, 'blocked');
        assert.deepEqual(JSON.parse(rows[0].detail), { product_id: PRD, link_id: LNK });
        assert.equal(await count(d1.db, 'audit_log', "action = 'contact_bound'"), 1); // 只有最初那一次
    });

    it('碼沒被燒掉：原綁定者之後用同一組碼（重綁自己）仍成功；被拒絕的人再試仍被拒', async () => {
        await bindText(await issue());
        const code2 = await issue();
        assert.equal((await bindText(code2, { userId: USER2 })).handled, false);
        assert.equal((await bindText(code2, { userId: USER2 })).handled, false);
        assert.deepEqual(await bindText(code2, { userId: USER }), { handled: true, replyText: BIND_CONFIRM_TEXT });
        assert.equal((await contactRows())[0].line_user_id, USER);
    });

    it('拒絕不吃每 bot 的「查無此碼」預算（碼是真的），也不會讓 bot 進入暫停', async () => {
        await withPinnedWindow(async () => {
            await bindText(await issue());
            const code2 = await issue();
            for (let i = 0; i < 9; i++) await bindText(code2, { userId: USER2 });
            assert.equal((await all(d1.db, 'SELECT n FROM counters WHERE scope_key = ?1', `bindfail:${BOT}`))[0].n, 0);
        });
    });

    it('同一位使用者重綁自己（預設碼）→ 成功（冪等），不通知任何人', async () => {
        await bindText(await issue());
        assert.deepEqual(await bindText(await issue(), { userId: USER }), { handled: true, replyText: BIND_CONFIRM_TEXT });
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, line_user_id: USER, status: 'bound' }]);
        assert.equal(pushes.length, 0);
        assert.equal(await count(d1.db, 'audit_log', "action = 'bind_rejected'"), 0);
    });

    it('既有綁定是 blocked（原使用者封鎖了 OA）也算被綁定：預設仍拒絕', async () => {
        await bindText(await issue());
        await bdb.markContactsBlockedByUser(env, { botId: BOT, lineUserId: USER });
        assert.equal((await bindText(await issue(), { userId: USER2 })).handled, false);
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, line_user_id: USER, status: 'blocked' }]);
    });

    it('沒有既有綁定時，任何使用者都能用預設碼綁定；其他 ref 的綁定不影響（只看同 (連結, ref)）', async () => {
        await bindText(await issue({ ref: REF2 }), { userId: USER });
        assert.equal((await bindText(await issue({ ref: REF }), { userId: USER2 })).handled, true);
    });

    it('allow_rebind = true 的碼：覆蓋、狀態回到 bound，並對「原綁定者」推一則「你的綁定已被更換」', async () => {
        await bindText(await issue());
        await bdb.markContactsBlockedByUser(env, { botId: BOT, lineUserId: USER });
        const r = await bindText(await issue({ allowRebind: true }), { userId: USER2 });
        assert.deepEqual(r, { handled: true, replyText: BIND_CONFIRM_TEXT });
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, line_user_id: USER2, status: 'bound' }]);
        assert.equal(pushes.length, 1);
        assert.equal(pushes[0].to, USER);
        assert.equal(pushes[0].auth, `Bearer ${LINE_TOKEN}`);
        assert.deepEqual(pushes[0].messages, [{ type: 'text', text: '你的綁定已被更換' }]);
        assert.equal(REBIND_NOTICE_TEXT, '你的綁定已被更換');
        assert.equal(await count(d1.db, 'audit_log', "action = 'bind_rejected'"), 0);
    });

    it('allow_rebind 的碼用在沒有人綁定的 ref、或原綁定者自己：不通知任何人', async () => {
        assert.equal((await bindText(await issue({ allowRebind: true }))).handled, true);
        assert.equal((await bindText(await issue({ allowRebind: true }), { userId: USER })).handled, true);
        assert.equal(pushes.length, 0);
    });

    it('通知原綁定者失敗（LINE 5xx、網路錯誤、沒有 token）→ 綁定照樣成功，錯誤吞掉，log 不含 userId', async () => {
        for (const impl of [() => new Response('{"message":"x"}', { status: 500 }), () => { throw new Error('network down'); }, () => new Response('{}', { status: 403 })]) {
            await d1.reset();
            await seedLink(d1.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY_A });
            pushImpl = impl;
            await bindText(await issue());
            const r = await bindText(await issue({ allowRebind: true }), { userId: USER2 });
            assert.equal(r.handled, true);
            assert.equal((await contactRows())[0].line_user_id, USER2);
        }
        await d1.reset();
        await seedLink(d1.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY_A });
        await bindText(await issue());
        await kv.delete(BotKeys.owner(BOT)); // 取不到 token
        assert.equal((await bindText(await issue({ allowRebind: true }), { userId: USER2 })).handled, true);
        const dump = logs.join('\n');
        for (const s of [USER, USER2, LINE_TOKEN]) assert.ok(!dump.includes(s), `log 含 ${s}`);
    });

    it('並行 10 個人用同一組預設碼搶已被綁定的 ref：全部被拒，碼仍可用，綁定不變', async () => {
        await bindText(await issue());
        const code2 = await issue();
        const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => bindText(code2, { userId: userOf(i) })));
        assert.ok(rs.every((r) => !r.handled));
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, line_user_id: USER, status: 'bound' }]);
        assert.equal((await codeRows()).filter((c) => c.used_at === null).length, 1);
        assert.equal(await count(d1.db, 'audit_log', "action = 'bind_rejected'"), 10);
    });

    it('並行 10 個人用同一組 allow_rebind 碼：只有 1 個贏、綁定是贏家的、只通知原綁定者 1 次', async () => {
        await bindText(await issue());
        const code2 = await issue({ allowRebind: true });
        const users = Array.from({ length: 10 }, (_, i) => userOf(i + 500));
        const rs = await Promise.all(users.map((u) => bindText(code2, { userId: u })));
        assert.equal(rs.filter((r) => r.handled).length, 1);
        const winner = users[rs.findIndex((r) => r.handled)];
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, line_user_id: winner, status: 'bound' }]);
        assert.equal(pushes.length, 1);
        assert.equal(pushes[0].to, USER);
    });

    it('db 層：被拒絕時 consumeBindCode 回 rejected 且不改任何列；成功時只在「覆蓋別人」才帶 previousUserId', async () => {
        const hash1 = await sha256Hex(await issue());
        const r1 = await bdb.consumeBindCode(env, { codeHash: hash1, botId: BOT, lineUserId: USER });
        assert.deepEqual(r1, { rejected: false, linkId: LNK, productId: PRD, ref: REF, previousUserId: null });
        const code2 = await issue();
        const hash2 = await sha256Hex(code2);
        const before = JSON.stringify(await all(d1.db, 'SELECT * FROM contacts'));
        assert.deepEqual(await bdb.consumeBindCode(env, { codeHash: hash2, botId: BOT, lineUserId: USER2 }), { rejected: true, linkId: LNK, productId: PRD });
        assert.equal(JSON.stringify(await all(d1.db, 'SELECT * FROM contacts')), before);
        assert.equal((await all(d1.db, 'SELECT used_at FROM bind_codes WHERE code_hash = ?1', hash2))[0].used_at, null);
        // 同一個人：不是覆蓋
        assert.equal((await bdb.consumeBindCode(env, { codeHash: hash2, botId: BOT, lineUserId: USER })).previousUserId, null);
        // 其他原因一律 null（不洩漏原因）：別的 bot、不存在、已用
        assert.equal(await bdb.consumeBindCode(env, { codeHash: hash2, botId: BOT, lineUserId: USER }), null);
        assert.equal(await bdb.consumeBindCode(env, { codeHash: 'nope', botId: BOT, lineUserId: USER }), null);
        const code3 = await issue({ allowRebind: true });
        const hash3 = await sha256Hex(code3);
        assert.equal(await bdb.consumeBindCode(env, { codeHash: hash3, botId: BOT2, lineUserId: USER2 }), null);
        assert.deepEqual(await bdb.consumeBindCode(env, { codeHash: hash3, botId: BOT, lineUserId: USER2 }), { rejected: false, linkId: LNK, productId: PRD, ref: REF, previousUserId: USER });
    });

    it('db 層：被拒絕的碼若同時已過期或連結已撤銷 → null，不是 rejected（不洩漏「碼是真的」）', async () => {
        await bindText(await issue());
        const expired = await issue({ now: Date.now() - 3 * 24 * HOUR });
        assert.equal(await bdb.consumeBindCode(env, { codeHash: await sha256Hex(expired), botId: BOT, lineUserId: USER2 }), null);
        const live = await issue();
        await d1.db.prepare("UPDATE links SET status = 'revoked', revoked_at = 5 WHERE link_id = ?1").bind(LNK).run();
        assert.equal(await bdb.consumeBindCode(env, { codeHash: await sha256Hex(live), botId: BOT, lineUserId: USER2 }), null);
    });
});

describe('POST /contacts/bind-tokens：allow_rebind', () => {
    const post = async (body, e = env) => {
        const url = new URL('https://worker.example.com/bridge/v1/contacts/bind-tokens');
        const res = await handleBridge(new Request(url, { method: 'POST', headers: { Authorization: `Bearer ${KEY_A}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), e, url.pathname);
        const text = await res.text();
        return { res, status: res.status, body: JSON.parse(text), text };
    };

    it('省略／false → allow_rebind 欄位 0；true → 1；回應形狀不變（只有 bind_code、bind_url、expires_at）', async () => {
        for (const [body, expected] of [[{}, 0], [{ allow_rebind: false }, 0], [{ allow_rebind: true }, 1]]) {
            const r = await post({ external_contact_ref: REF, ...body });
            assert.equal(r.status, 201, r.text);
            assert.deepEqual(Object.keys(r.body).sort(), ['bind_code', 'bind_url', 'expires_at']);
            assert.match(r.body.bind_code, /^LM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
            assert.equal(r.body.bind_url, `https://line.me/R/oaMessage/@123abcde/?${r.body.bind_code}`);
            assert.equal((await codeRows())[0].allow_rebind, expected);
        }
    });

    it('allow_rebind 不是 boolean（"true"、1、0、null、物件、陣列）→ 400 INVALID_REQUEST，沒有發碼', async () => {
        for (const v of ['true', 'false', 1, 0, null, {}, []]) {
            const r = await post({ external_contact_ref: REF, allow_rebind: v });
            assert.equal(r.status, 400, JSON.stringify(v));
            assert.equal(r.body.error.code, 'INVALID_REQUEST');
            assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message', 'retryable']);
        }
        assert.equal(await count(d1.db, 'bind_codes'), 0);
    });

    it('端到端：發出的 allow_rebind 碼，經 webhook 換綁並通知原綁定者；預設碼則被拒', async () => {
        const first = await post({ external_contact_ref: REF });
        assert.equal((await bindText(first.body.bind_code)).handled, true);
        const plain = await post({ external_contact_ref: REF });
        assert.equal((await bindText(plain.body.bind_code, { userId: USER2 })).handled, false);
        const rebind = await post({ external_contact_ref: REF, allow_rebind: true });
        assert.equal((await bindText(rebind.body.bind_code, { userId: USER2 })).handled, true);
        assert.equal((await contactRows())[0].line_user_id, USER2);
        assert.deepEqual(pushes.map((p) => p.to), [USER]);
    });

    it('同 (連結, ref) 再發碼會作廢舊碼：先發 allow_rebind、再發預設 → 舊的 allow_rebind 碼失效（不能留下較寬鬆的碼）', async () => {
        await bindText((await post({ external_contact_ref: REF })).body.bind_code);
        const loose = await post({ external_contact_ref: REF, allow_rebind: true });
        const strict = await post({ external_contact_ref: REF });
        assert.equal((await bindText(loose.body.bind_code, { userId: USER2 })).handled, false);
        assert.equal((await bindText(strict.body.bind_code, { userId: USER2 })).handled, false);
        assert.equal((await contactRows())[0].line_user_id, USER);
    });
});

describe('缺 0004 遷移（只套用 0001～0003）→ fail-closed', () => {
    let old;
    before(async () => { old = await createTestD1({ upTo: '0003' }); });
    after(async () => { await old.dispose(); });

    it('webhook：長得像碼的文字 → {handled:false}，沒有綁定、碼沒被消耗', async () => {
        await old.reset();
        await seedLink(old.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY_A });
        const code = generateBindCode();
        await old.db.prepare(
            'INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        ).bind(await sha256Hex(code), LNK, BOT, REF, Date.now(), Date.now() + HOUR).run();
        const e = { ...env, BRIDGE_DB: old.db };
        assert.deepEqual(await bindText(formatBindCode(code), { e }), { handled: false });
        assert.equal(await count(old.db, 'contacts'), 0);
        assert.equal((await all(old.db, 'SELECT used_at FROM bind_codes'))[0].used_at, null);
    });

    it('POST /contacts/bind-tokens → 503 bridge_not_configured（沒有發碼）', async () => {
        await old.reset();
        await seedLink(old.db, { linkId: LNK, productId: PRD, botId: BOT, key: KEY_A });
        const url = new URL('https://worker.example.com/bridge/v1/contacts/bind-tokens');
        const res = await handleBridge(new Request(url, {
            method: 'POST', headers: { Authorization: `Bearer ${KEY_A}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ external_contact_ref: REF }),
        }), { ...env, BRIDGE_DB: old.db }, url.pathname);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.error.code, 'INTERNAL');
        assert.equal(body.error.message, 'bridge_not_configured');
        assert.equal(await count(old.db, 'bind_codes'), 0);
    });
});

describe('隱私：計數鍵、旗標、稽核、log 不含碼、ref、LINE userId', () => {
    it('走完綁定、拒絕、換綁、暫停、錯碼之後掃描', async () => {
        await withPinnedWindow(async () => {
            const c1 = await issue();
            await bindText(c1);
            const c2 = await issue();
            await bindText(c2, { userId: USER2 }); // 拒絕
            const c3 = await issue({ allowRebind: true });
            await bindText(c3, { userId: USER3 }); // 換綁
            for (let i = 0; i <= BOT_FAILURE_CAP + 1; i++) await bindText(wrong(i), { userId: userOf(i) }); // 暫停
            const secrets = [USER, USER2, USER3, REF, c1, c2, c3, formatBindCode(c1), formatBindCode(c3), await sha256Hex(c1), LINE_TOKEN];
            const surfaces = {
                counters: JSON.stringify(await all(d1.db, 'SELECT * FROM counters')),
                flags: JSON.stringify(await all(d1.db, 'SELECT * FROM flags')),
                audit: JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log')),
                logs: logs.join('\n'),
            };
            for (const [name, text] of Object.entries(surfaces)) {
                for (const s of secrets) assert.ok(!text.includes(s), `${name} 含 ${s}`);
            }
            const actions = (await all(d1.db, 'SELECT action FROM audit_log')).map((r) => r.action);
            for (const a of ['contact_bound', 'bind_rejected', 'bind_paused']) assert.ok(actions.includes(a), a);
        });
    });
});
