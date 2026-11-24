/**
 * Unit Tests — 聯絡人綁定的資料層與 webhook 側邏輯（LM-3A：bridge/db.js 新函式 + bridge/binding.js）
 *
 * 用 Miniflare 的真 D1。重點：
 *   - 碼的格式與隨機性；辨識規則（完全符合才算，近似字串不誤觸，非法輸入零 D1 查詢）
 *   - 單次使用（並行消耗只有一個贏）、過期、跨 bot 無效、連結撤銷後無效、同 (連結, ref) 新碼作廢舊碼
 *   - 覆蓋綁定、同一使用者多個 ref、每連結有效碼上限
 *   - unfollow／follow 狀態轉換（只還原 blocked，不新建）
 *   - 旗標關閉 → 零 D1；D1 失敗 → {handled:false}；log／audit 不含碼與 LINE userId
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { seedLink, countingDb, all, count } from '../helpers/bridge_seed.mjs';
import { sha256Hex } from '../../worker_src/lib/crypto_util.js';
import * as bdb from '../../worker_src/bridge/db.js';
import {
    generateBindCode, formatBindCode, normalizeBindCode, tryConsumeBindCode, markBlocked, restoreFollow,
    BIND_CODE_RE, BIND_CODE_TTL_MS, BIND_CONFIRM_TEXT,
} from '../../worker_src/bridge/binding.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT2 = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const LNK = 'lnk_aaaaaaaaaaaaaaaa';
const LNK2 = 'lnk_bbbbbbbbbbbbbbbb';
const PRD = 'prd_aaaaaaaaaaaa';
const USER = 'Uuser00000000000000000000000001';
const USER2 = 'Uuser00000000000000000000000002';
const REF = 'customer-0001';
const REF2 = 'customer-0002';
const ALPHABET_RE = /^LM-[0-9A-HJKMNP-TV-Z]{12}$/;

let d1;
let env;
let logs;
const originalError = console.error;
const originalLog = console.log;
const originalWarn = console.warn;

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    env = { BRIDGE_DB: d1.db, BRIDGE_ENABLED: '1', KV_LINE_STORAGE: createMockKV() };
    logs = [];
    const grab = (...a) => logs.push(a.map(String).join(' '));
    console.error = grab; console.log = grab; console.warn = grab;
    await seedLink(d1.db, { linkId: LNK, botId: BOT, key: 'brk_test_a' });
});
afterEach(() => { console.error = originalError; console.log = originalLog; console.warn = originalWarn; });

/** 直接用 db 層發一組碼（回明文碼） */
async function issue({ linkId = LNK, botId = BOT, ref = REF, now = Date.now(), ttl = BIND_CODE_TTL_MS, allowRebind = false } = {}) {
    const code = generateBindCode();
    const r = await bdb.createBindCode(env, { codeHash: await sha256Hex(code), linkId, botId, ref, expiresAt: now + ttl, now, allowRebind });
    assert.deepEqual(r, { created: true });
    return code;
}

const contactRows = () => all(d1.db, 'SELECT link_id, external_contact_ref AS ref, bot_id, line_user_id, status FROM contacts ORDER BY external_contact_ref');

// ───────────────────────── 碼的格式與辨識 ─────────────────────────

describe('generateBindCode', () => {
    it('M-02：格式是 LM- + 12 碼 Crockford base32（60 bit，不含 I、L、O、U）；顯示形式是 LM-XXXX-XXXX-XXXX', () => {
        for (let i = 0; i < 500; i++) {
            const c = generateBindCode();
            assert.match(c, ALPHABET_RE);
            assert.doesNotMatch(c.slice(3), /[ILOU]/);
            assert.match(formatBindCode(c), /^LM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
            assert.equal(normalizeBindCode(formatBindCode(c)), c);
        }
        assert.equal(BIND_CODE_RE.test('LM-ABCDEFGHJKMN'), true);
        assert.equal(BIND_CODE_RE.test('LM-ABCDEFGI'), false); // I 不在字母集
        assert.equal(formatBindCode('LM-ABCDEFGH'), 'LM-ABCDEFGH'); // 舊的 8 碼原樣
    });

    it('隨機：2000 組不重複，且 32 個字元都出現過、分布不偏', () => {
        const seen = new Set();
        const freq = new Map();
        for (let i = 0; i < 2000; i++) {
            const c = generateBindCode();
            seen.add(c);
            for (const ch of c.slice(3)) freq.set(ch, (freq.get(ch) || 0) + 1);
        }
        assert.equal(seen.size, 2000);
        assert.equal(freq.size, 32);
        // 24000 個字元 / 32 ≈ 750；寬鬆範圍只擋「明顯偏斜」
        for (const n of freq.values()) assert.ok(n > 600 && n < 900, String(n));
    });
});

describe('normalizeBindCode（辨識規則）', () => {
    it('trim、不分大小寫 → 回大寫標準形（舊的 8 碼仍認得）', () => {
        assert.equal(normalizeBindCode('LM-ABCD2345'), 'LM-ABCD2345');
        assert.equal(normalizeBindCode('  lm-abcd2345 \n'), 'LM-ABCD2345');
        assert.equal(normalizeBindCode('Lm-AbCd2345'), 'LM-ABCD2345');
        assert.equal(normalizeBindCode('　LM-ABCD2345　'), 'LM-ABCD2345'); // 全形空白也會被 trim
    });

    it('M-02：新碼有無連字號、大小寫、前後空白都回同一個標準形', () => {
        for (const t of ['LM-ABCD-2345-WXYZ', 'LM-ABCD2345WXYZ', 'lm-abcd-2345-wxyz', '  Lm-AbCd-2345-WxYz\n', 'LM-ABCD-2345WXYZ', 'LM-ABCD2345-WXYZ', '　LM-ABCD2345WXYZ　']) {
            assert.equal(normalizeBindCode(t), 'LM-ABCD2345WXYZ', JSON.stringify(t));
        }
    });

    it('M-02：新碼的近似字串不誤觸（缺漏、多餘、非法字母、錯誤分組、夾雜文字）', () => {
        for (const t of [
            'LM-ABCD-2345-WXY', 'LM-ABCD-2345-WXYZ1', 'LM-ABCD-2345-WXYI', 'LM-ABCD-2345-WXYO', 'LM-ABCD-2345-WXYL', 'LM-ABCD-2345-WXYU',
            'LM-ABC-D2345-WXYZ', 'LM-AB-CD-2345-WXYZ', 'LM--ABCD-2345-WXYZ', 'LM-ABCD--2345-WXYZ', 'LM-ABCD-2345-WXYZ-',
            'LM-ABCD 2345 WXYZ', 'LM-ABCD_2345_WXYZ', 'LM-ABCD-2345', 'LM-ABCD-2345-', 'LM-ABCD2345WXYZ12', 'LM-ABCD2345WXY',
            'LMABCD2345WXYZ', 'LM:ABCD-2345-WXYZ', '請綁定 LM-ABCD-2345-WXYZ', 'LM-ABCD-2345-WXYZ 謝謝', 'LM-ＡＢＣＤ-2345-WXYZ', 'LM-ſBCD-2345-WXYZ',
            'LM-ABCD-2345-WXYZ\nLM-ABCD-2345-WXYZ',
        ]) {
            assert.equal(normalizeBindCode(t), null, JSON.stringify(t));
        }
    });

    it('近似字串一律不是綁定碼', () => {
        for (const t of [
            'LM-1234567', 'LM-123456789', 'hello LM-ABCD2345', 'LM-ABCD2345 hello', 'LM-ABCD2345\nLM-ABCD2345',
            'LM ABCD2345', 'LM_ABCD2345', 'LM-ABCD234I', 'LM-ABCD234L', 'LM-ABCD234O', 'LM-ABCD234U',
            'LM-', '', '   ', 'ABCD2345', 'LMABCD2345', 'xLM-ABCD2345', 'LM-ABCD-2345', 'LM-ＡＢＣＤ２３４５', // 舊碼不接受中間連字號
            'LM-ſBCD2345', // ſ（U+017F）大寫後會變 S：不可混進來
            '綁定 LM-ABCD2345', 'LM-ABCD2345。',
        ]) {
            assert.equal(normalizeBindCode(t), null, JSON.stringify(t));
        }
    });

    it('非字串與過長輸入 → null', () => {
        for (const t of [null, undefined, 123, {}, [], 'LM-ABCD2345'.padEnd(5000, ' ')]) assert.equal(normalizeBindCode(t), null);
    });
});

describe('tryConsumeBindCode：不像綁定碼 → 零 D1 查詢', () => {
    it('一般聊天、近似字串、非字串都不碰 D1、也不碰 KV 限流', async () => {
        const c = countingDb(d1.db);
        const kvGets = [];
        const kv = { get: async (k) => { kvGets.push(k); return null; }, put: async (k) => { kvGets.push(k); } };
        const e = { ...env, BRIDGE_DB: c.db, KV_LINE_STORAGE: kv };
        for (const text of ['你好', 'LM-1234567', 'hello LM-ABCD2345', 'LM-ABCD-2345-WXY', 'LM-ABCD-2345-WXYI', '', undefined, 42]) {
            assert.deepEqual(await tryConsumeBindCode(e, { botId: BOT, lineUserId: USER, text }), { handled: false });
        }
        assert.equal(c.counter.total, 0);
        assert.deepEqual(kvGets, []);
    });
});

// ───────────────────────── 消耗 ─────────────────────────

describe('tryConsumeBindCode：成功', () => {
    it('寫入綁定、回確認文字；大小寫與前後空白不影響；碼只用一次', async () => {
        const code = await issue();
        const r = await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: `  ${code.toLowerCase()} ` });
        assert.deepEqual(r, { handled: true, replyText: BIND_CONFIRM_TEXT });
        assert.equal(BIND_CONFIRM_TEXT, '已完成綁定，之後會在這裡通知你');
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, bot_id: BOT, line_user_id: USER, status: 'bound' }]);
        const used = await all(d1.db, 'SELECT used_at FROM bind_codes');
        assert.equal(used.length, 1);
        assert.ok(used[0].used_at > 0);
        // 再傳一次 → 不處理（已用）
        assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
    });

    it('audit contact_bound：actor 是 system/webhook，detail 只有 product_id 與 link_id', async () => {
        const code = await issue();
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code });
        const rows = await all(d1.db, "SELECT * FROM audit_log WHERE action = 'contact_bound'");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].actor_type, 'system');
        assert.equal(rows[0].bot_id, BOT);
        assert.equal(rows[0].result, 'ok');
        assert.deepEqual(JSON.parse(rows[0].detail), { product_id: PRD, link_id: LNK });
        const dump = JSON.stringify(await all(d1.db, 'SELECT * FROM audit_log'));
        for (const secret of [USER, REF, code, await sha256Hex(code)]) assert.ok(!dump.includes(secret));
    });

    it('並行 10 個人同時傳同一組碼：只有 1 個贏，綁定只寫一筆', async () => {
        const code = await issue();
        const users = Array.from({ length: 10 }, (_, i) => `Uracer${String(i).padStart(26, '0')}`);
        const results = await Promise.all(users.map((u) => tryConsumeBindCode(env, { botId: BOT, lineUserId: u, text: code })));
        assert.equal(results.filter((r) => r.handled).length, 1);
        const rows = await contactRows();
        assert.equal(rows.length, 1);
        assert.ok(users.includes(rows[0].line_user_id));
        assert.equal(await count(d1.db, 'audit_log', "action = 'contact_bound'"), 1);
    });

    it('同一個 db 層函式並行消耗：meta.changes 只讓一個成功', async () => {
        const code = await issue();
        const h = await sha256Hex(code);
        const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => bdb.consumeBindCode(env, { codeHash: h, botId: BOT, lineUserId: `Urace${String(i).padStart(28, '0')}` })));
        assert.equal(rs.filter(Boolean).length, 1);
        assert.deepEqual(rs.find(Boolean), { rejected: false, linkId: LNK, productId: PRD, ref: REF, previousUserId: null, hasSegment: false });
        assert.equal(await count(d1.db, 'contacts'), 1);
    });
});

describe('tryConsumeBindCode：失敗一律 {handled:false}，沒有任何綁定', () => {
    it('不存在的碼', async () => {
        assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: 'LM-23456789' }), { handled: false });
        assert.equal(await count(d1.db, 'contacts'), 0);
    });

    it('過期的碼', async () => {
        const now = Date.now();
        const code = await issue({ now: now - 49 * 3600 * 1000 }); // 49 小時前發的，48 小時 TTL 已過
        assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
        assert.equal(await count(d1.db, 'contacts'), 0);
        // 剛好在期限內仍有效
        const ok = await issue({ ref: REF2, now: now - 47 * 3600 * 1000 });
        assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: ok })).handled, true);
    });

    it('別的 OA 傳的碼無效，而且不會燒掉碼：在正確的 OA 仍可使用', async () => {
        const code = await issue();
        assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT2, lineUserId: USER, text: code }), { handled: false });
        assert.equal((await all(d1.db, 'SELECT used_at FROM bind_codes'))[0].used_at, null);
        assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code })).handled, true);
    });

    it('連結已撤銷 → 碼無效（不建立綁定），碼也不會被燒掉', async () => {
        const code = await issue();
        await d1.db.prepare("UPDATE links SET status = 'revoked', revoked_at = 5 WHERE link_id = ?1").bind(LNK).run();
        assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
        assert.equal(await count(d1.db, 'contacts'), 0);
    });

    it('同 (連結, ref) 再發新碼 → 舊的未用碼作廢，只有最新一組有效', async () => {
        const first = await issue();
        const second = await issue();
        const third = await issue();
        assert.equal(await count(d1.db, 'bind_codes'), 1);
        for (const old of [first, second]) {
            assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: old }), { handled: false });
        }
        assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: third })).handled, true);
    });

    it('發新碼不影響同連結其他 ref 的碼，也不影響其他連結同名 ref 的碼', async () => {
        await seedLink(d1.db, { linkId: LNK2, botId: BOT, productId: 'prd_bbbbbbbbbbbb', key: 'brk_test_b' });
        const a = await issue({ ref: REF });
        const b = await issue({ ref: REF2 });
        const c = await issue({ linkId: LNK2, ref: REF });
        await issue({ ref: REF }); // 作廢 a
        assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: a })).handled, false);
        assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: b })).handled, true);
        assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER2, text: c })).handled, true);
    });

    it('限流：同一 (bot, 使用者) 超過嘗試上限後，連正確的碼也暫時不處理', async () => {
        // 固定視窗限流：時間釘在視窗中段，避免嘗試跨過整分鐘邊界而偶發失敗
        const realNow = Date.now;
        const pinned = Math.floor(realNow() / 60000) * 60000 + 20000;
        Date.now = () => pinned;
        try {
            const code = await issue();
            for (let i = 0; i < 10; i++) {
                assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: 'LM-23456789' })).handled, false);
            }
            assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
            assert.equal(await count(d1.db, 'contacts'), 0);
            // 另一個使用者不受影響
            assert.equal((await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER2, text: code })).handled, true);
        } finally {
            Date.now = realNow;
        }
    });
});

describe('綁定策略', () => {
    // M-02／D6 刻意改寫：原本「新的 LINE 使用者直接覆蓋」改成「預設拒絕；發碼時 allow_rebind = true 才覆蓋」。
    // 覆蓋的狀態轉換（blocked → bound）仍在這裡驗證，只是改用 allowRebind 發碼。
    it('同 (連結, ref) 從新的 LINE 使用者重新綁定：發碼時 allowRebind = true → 覆蓋，狀態回到 bound', async () => {
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue() });
        await markBlocked(env, { botId: BOT, lineUserId: USER });
        assert.equal((await contactRows())[0].status, 'blocked');
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER2, text: await issue({ allowRebind: true }) });
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, bot_id: BOT, line_user_id: USER2, status: 'bound' }]);
    });

    it('預設（allowRebind 未設）：另一位使用者想綁已被綁定的 ref → 不覆蓋', async () => {
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue() });
        const r = await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER2, text: await issue() });
        assert.deepEqual(r, { handled: false });
        assert.deepEqual(await contactRows(), [{ link_id: LNK, ref: REF, bot_id: BOT, line_user_id: USER, status: 'bound' }]);
    });

    it('同一個 LINE 使用者可以綁同連結的多個 ref', async () => {
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue({ ref: REF }) });
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue({ ref: REF2 }) });
        const rows = await contactRows();
        assert.deepEqual(rows.map((r) => [r.ref, r.line_user_id]), [[REF, USER], [REF2, USER]]);
    });
});

// ───────────────────────── 上限 ─────────────────────────

describe('createBindCode：每連結有效未用碼上限', () => {
    const make = async (ref, maxLive, linkId = LNK) => bdb.createBindCode(env, {
        codeHash: await sha256Hex(generateBindCode()), linkId, botId: BOT, ref, expiresAt: Date.now() + 1e6, now: Date.now(), maxLive,
    });

    it('預設上限是 1000', () => {
        assert.equal(bdb.MAX_LIVE_BIND_CODES_PER_LINK, 1000);
    });

    it('到上限後新 ref 被擋（capped）；既有 ref 重發不受限（舊碼換新碼），而且被擋時舊碼原封不動', async () => {
        assert.deepEqual(await make('ref-00000001', 3), { created: true });
        assert.deepEqual(await make('ref-00000002', 3), { created: true });
        assert.deepEqual(await make('ref-00000003', 3), { created: true });
        assert.deepEqual(await make('ref-00000004', 3), { created: false, capped: true });
        assert.equal(await count(d1.db, 'bind_codes'), 3);
        assert.deepEqual(await make('ref-00000001', 3), { created: true }); // 換新碼
        assert.equal(await count(d1.db, 'bind_codes'), 3);
    });

    it('上限只算這條連結；已用與已過期的碼不算', async () => {
        await seedLink(d1.db, { linkId: LNK2, botId: BOT, productId: 'prd_bbbbbbbbbbbb', key: 'brk_test_b' });
        await make('ref-00000001', 1);
        assert.deepEqual(await make('ref-00000009', 1, LNK2), { created: true }); // 別條連結
        assert.deepEqual(await make('ref-00000002', 1), { created: false, capped: true });
        await d1.db.prepare('UPDATE bind_codes SET used_at = 1 WHERE link_id = ?1').bind(LNK).run();
        assert.deepEqual(await make('ref-00000002', 1), { created: true });
        await d1.db.prepare('UPDATE bind_codes SET expires_at = 1 WHERE link_id = ?1').bind(LNK).run();
        assert.deepEqual(await make('ref-00000003', 1), { created: true });
    });

    it('發碼時順手清掉過期超過一天的舊碼', async () => {
        const now = Date.now();
        await d1.db.prepare("INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at) VALUES ('old','l','b','r',1,?1)")
            .bind(now - 2 * 24 * 3600 * 1000).run();
        await d1.db.prepare("INSERT INTO bind_codes (code_hash, link_id, bot_id, external_contact_ref, created_at, expires_at) VALUES ('recent','l','b','r',1,?1)")
            .bind(now - 3600 * 1000).run();
        await make('ref-00000001', 10);
        const hashes = (await all(d1.db, 'SELECT code_hash FROM bind_codes')).map((r) => r.code_hash);
        assert.ok(!hashes.includes('old'));
        assert.ok(hashes.includes('recent'));
    });

    it('雜湊撞到既有列 → {created:false, conflict:true}，整批回滾（舊碼還在）', async () => {
        const first = await issue();
        const r = await bdb.createBindCode(env, {
            codeHash: await sha256Hex(first), linkId: LNK, botId: BOT, ref: REF2, expiresAt: Date.now() + 1e6,
        });
        assert.deepEqual(r, { created: false, conflict: true });
        assert.equal(await count(d1.db, 'bind_codes'), 1);
    });
});

// ───────────────────────── unfollow / follow ─────────────────────────

describe('unfollow / follow', () => {
    it('markBlocked 把這個 bot 之下該使用者的 bound 列設成 blocked；其他人、其他 bot 不受影響', async () => {
        await seedLink(d1.db, { linkId: LNK2, botId: BOT2, productId: 'prd_bbbbbbbbbbbb', key: 'brk_test_b' });
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue({ ref: REF }) });
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue({ ref: REF2 }) });
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER2, text: await issue({ ref: 'customer-0003' }) });
        await tryConsumeBindCode(env, { botId: BOT2, lineUserId: USER, text: await issue({ linkId: LNK2, botId: BOT2, ref: REF }) });

        assert.equal(await markBlocked(env, { botId: BOT, lineUserId: USER }), 2);
        const rows = await all(d1.db, 'SELECT link_id, external_contact_ref AS ref, status FROM contacts ORDER BY link_id, ref');
        assert.deepEqual(rows, [
            { link_id: LNK, ref: REF, status: 'blocked' },
            { link_id: LNK, ref: REF2, status: 'blocked' },
            { link_id: LNK, ref: 'customer-0003', status: 'bound' },
            { link_id: LNK2, ref: REF, status: 'bound' },
        ]);
        assert.equal(await markBlocked(env, { botId: BOT, lineUserId: USER }), 0); // 已是 blocked
    });

    it('restoreFollow 只還原 blocked，且不新建綁定（沒綁過的人 follow 什麼都不發生）', async () => {
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue() });
        await markBlocked(env, { botId: BOT, lineUserId: USER });
        assert.equal(await restoreFollow(env, { botId: BOT, lineUserId: USER2 }), 0);
        assert.equal(await count(d1.db, 'contacts'), 1);
        assert.equal(await restoreFollow(env, { botId: BOT, lineUserId: USER }), 1);
        assert.equal((await contactRows())[0].status, 'bound');
        assert.equal(await restoreFollow(env, { botId: BOT, lineUserId: USER }), 0);
    });

    it('旗標關閉或參數不合 → 0 且零 D1；D1 壞掉 → 0 不丟錯', async () => {
        const c = countingDb(d1.db);
        for (const e of [{ ...env, BRIDGE_ENABLED: undefined }, { ...env, BRIDGE_ENABLED: 'true' }, { ...env, BRIDGE_ENABLED: '0' }]) {
            assert.equal(await markBlocked({ ...e, BRIDGE_DB: c.db }, { botId: BOT, lineUserId: USER }), 0);
            assert.equal(await restoreFollow({ ...e, BRIDGE_DB: c.db }, { botId: BOT, lineUserId: USER }), 0);
        }
        assert.equal(await markBlocked({ ...env, BRIDGE_DB: c.db }, { botId: '', lineUserId: USER }), 0);
        assert.equal(await restoreFollow({ ...env, BRIDGE_DB: c.db }, { botId: BOT }), 0);
        assert.equal(c.counter.total, 0);
        assert.equal(await markBlocked({ BRIDGE_ENABLED: '1' }, { botId: BOT, lineUserId: USER }), 0);
        assert.equal(await restoreFollow({ BRIDGE_ENABLED: '1' }, { botId: BOT, lineUserId: USER }), 0);
        assert.equal(await markBlocked(undefined), 0);
    });
});

// ───────────────────────── 旗標與失敗 ─────────────────────────

describe('旗標與失敗', () => {
    it('BRIDGE_ENABLED 不是 "1" → {handled:false}，零 D1、零 KV，即使碼完全正確', async () => {
        const code = await issue();
        const c = countingDb(d1.db);
        let kvTouched = 0;
        const kv = { get: async () => { kvTouched++; return null; }, put: async () => { kvTouched++; } };
        for (const flag of [undefined, '', '0', 'true', 'yes', 1]) {
            const e = { ...env, BRIDGE_ENABLED: flag, BRIDGE_DB: c.db, KV_LINE_STORAGE: kv };
            assert.deepEqual(await tryConsumeBindCode(e, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
        }
        assert.equal(c.counter.total, 0);
        assert.equal(kvTouched, 0);
        assert.equal(await count(d1.db, 'contacts'), 0);
    });

    it('D1 失敗（缺 binding、缺表）→ {handled:false}，不丟錯，log 不含碼與 userId', async () => {
        const code = generateBindCode();
        assert.deepEqual(await tryConsumeBindCode({ BRIDGE_ENABLED: '1' }, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
        await d1.db.prepare('ALTER TABLE bind_codes RENAME TO bind_codes_hidden').run();
        try {
            assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
        } finally {
            await d1.db.prepare('ALTER TABLE bind_codes_hidden RENAME TO bind_codes').run();
        }
        assert.ok(logs.length > 0);
        const dump = logs.join('\n');
        assert.ok(!dump.includes(code));
        assert.ok(!dump.includes(USER));
    });

    it('消耗成功但寫入綁定失敗 → {handled:false}（走原流程），不丟錯', async () => {
        const code = await issue();
        await d1.db.prepare('ALTER TABLE contacts RENAME TO contacts_hidden').run();
        try {
            assert.deepEqual(await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code }), { handled: false });
        } finally {
            await d1.db.prepare('ALTER TABLE contacts_hidden RENAME TO contacts').run();
        }
        assert.ok(!logs.join('\n').includes(code));
    });

    it('成功路徑本身不產生任何 log（碼與 userId 不外流）', async () => {
        const code = await issue();
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: code });
        await markBlocked(env, { botId: BOT, lineUserId: USER });
        await restoreFollow(env, { botId: BOT, lineUserId: USER });
        assert.deepEqual(logs, []);
    });
});

// ───────────────────────── 資料層：狀態原料、刪除 ─────────────────────────

describe('getContactSnapshot / deleteContact', () => {
    it('沒有綁定也沒有碼 → contact null、hasPendingCode false；連結不存在 → null', async () => {
        assert.deepEqual(await bdb.getContactSnapshot(env, { linkId: LNK, ref: REF }), {
            linkStatus: 'active', productDisabled: false, contact: null, hasPendingCode: false,
        });
        assert.equal(await bdb.getContactSnapshot(env, { linkId: 'lnk_zzzzzzzzzzzzzzzz', ref: REF }), null);
    });

    it('回傳物件沒有任何 line_user_id（序列化後也找不到）', async () => {
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue() });
        const snap = await bdb.getContactSnapshot(env, { linkId: LNK, ref: REF });
        assert.equal(snap.contact.status, 'bound');
        assert.ok(!JSON.stringify(snap).includes(USER));
        assert.ok(!/user/i.test(Object.keys(snap.contact).join()));
    });

    it('待用碼：過期或已用的不算 pending', async () => {
        const now = Date.now();
        await issue({ now });
        assert.equal((await bdb.getContactSnapshot(env, { linkId: LNK, ref: REF, now })).hasPendingCode, true);
        assert.equal((await bdb.getContactSnapshot(env, { linkId: LNK, ref: REF, now: now + BIND_CODE_TTL_MS + 1 })).hasPendingCode, false);
        await d1.db.prepare('UPDATE bind_codes SET used_at = 1').run();
        assert.equal((await bdb.getContactSnapshot(env, { linkId: LNK, ref: REF, now })).hasPendingCode, false);
    });

    it('deleteContact：刪該 (連結, ref) 的綁定與全部碼，不動別的 ref／別條連結', async () => {
        await seedLink(d1.db, { linkId: LNK2, botId: BOT, productId: 'prd_bbbbbbbbbbbb', key: 'brk_test_b' });
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue({ ref: REF }) });
        await issue({ ref: REF }); // 又發一組待用碼
        await tryConsumeBindCode(env, { botId: BOT, lineUserId: USER, text: await issue({ ref: REF2 }) });
        await issue({ linkId: LNK2, ref: REF });
        assert.deepEqual(await bdb.deleteContact(env, { linkId: LNK, ref: REF }), { contactDeleted: true, codesDeleted: 2 });
        assert.deepEqual((await contactRows()).map((r) => r.ref), [REF2]);
        assert.equal(await count(d1.db, 'bind_codes', 'link_id = ?1', LNK2), 1);
        assert.deepEqual(await bdb.deleteContact(env, { linkId: LNK, ref: REF }), { contactDeleted: false, codesDeleted: 0 });
    });
});

describe('fail-closed 與稽核白名單', () => {
    it('沒有 BRIDGE_DB → 每個新函式都丟 BridgeDbError', async () => {
        const h = 'a'.repeat(64);
        const calls = [
            () => bdb.createBindCode({}, { codeHash: h, linkId: LNK, botId: BOT, ref: REF, expiresAt: 2 }),
            () => bdb.consumeBindCode({}, { codeHash: h, botId: BOT }),
            () => bdb.upsertContactBinding({}, { linkId: LNK, ref: REF, botId: BOT, lineUserId: USER }),
            () => bdb.getContactSnapshot({}, { linkId: LNK, ref: REF }),
            () => bdb.deleteContact({}, { linkId: LNK, ref: REF }),
            () => bdb.markContactsBlockedByUser({}, { botId: BOT, lineUserId: USER }),
            () => bdb.restoreContactsByUser({}, { botId: BOT, lineUserId: USER }),
        ];
        for (const c of calls) await assert.rejects(c, bdb.BridgeDbError);
    });

    it('sanitizeDetail 不收 line_user_id、external_contact_ref、碼：即使呼叫端塞進來也被丟掉', async () => {
        await bdb.writeAudit(env, {
            actorType: 'system', action: 'contact_bound', result: 'ok',
            detail: { product_id: PRD, link_id: LNK, line_user_id: USER, external_contact_ref: REF, ref: REF, code: 'LM-23456789', bind_code: 'LM-23456789', user_id: USER },
        });
        const row = (await all(d1.db, 'SELECT detail FROM audit_log'))[0];
        assert.deepEqual(JSON.parse(row.detail), { product_id: PRD, link_id: LNK });
    });
});
