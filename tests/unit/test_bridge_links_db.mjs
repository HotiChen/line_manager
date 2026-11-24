/**
 * Unit Tests — bridge/db.js 的連結資料層（LM-2A）
 *
 * 用 Miniflare 的真 D1。重點是原子性：
 *   - 授權碼：並行 8 個消耗只有 1 個成功（單一 UPDATE，meta.changes === 1）；過期、已用、產品或 redirect_uri 不符都回 null
 *   - 建立連結：撤銷舊連結與舊金鑰＋建新連結＋發新金鑰是同一個 batch；失敗整批回滾
 *   - 撤銷／輪替：只動「這個 bot 的 active 連結」；並行輪替後恰好一把有效
 *   - 連結金鑰認證查詢：金鑰 → 連結 → 產品；系統金鑰通不過既有的系統認證查詢
 *   - 稽核白名單：product_id、link_id、error_code 以嚴格 regex 驗證
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { seedSystem, seedKey, all, count } from '../helpers/bridge_seed.mjs';
import * as bdb from '../../worker_src/bridge/db.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const OTHER_BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
const PRD = 'prd_aaaaaaaaaaaa';
const LNK = 'lnk_aaaaaaaaaaaaaaaa';
const H = (c) => c.repeat(64);
const URI = 'https://picker.example.com/cb';

let d1;
let env;
const originalError = console.error;

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => {
    await d1.reset();
    env = { BRIDGE_DB: d1.db };
    console.error = () => {};
});
afterEach(() => { console.error = originalError; });

const newProduct = (over = {}) => ({
    productId: PRD, name: 'Image Picker', secretHash: H('9'), redirectUris: [URI], urlDomains: ['picker.example.com'],
    scopes: ['link:manage', 'contacts:bind', 'messages:send'], now: 1000, ...over,
});
const newLink = (over = {}) => ({
    linkId: LNK, productId: PRD, botId: BOT, scopes: ['link:manage', 'contacts:bind', 'messages:send'],
    createdBy: 'Uowner', keyHash: H('a'), now: 2000, ...over,
});
const newCode = (over = {}) => ({
    codeHash: H('c'), productId: PRD, botId: BOT, redirectUri: URI, scopes: ['link:manage'],
    createdBy: 'Uowner', expiresAt: 10_000, now: 1000, ...over,
});

/** 讓 batch 多帶一句會違反 NOT NULL 的敘述：整批必須回滾 */
function failingBatchDb(real) {
    return {
        prepare: (s) => real.prepare(s),
        batch: (stmts) => real.batch([...stmts, real.prepare('INSERT INTO products (product_id) VALUES (NULL)')]),
    };
}

describe('fail-closed', () => {
    it('沒有 BRIDGE_DB → 每個新函式都丟 BridgeDbError', async () => {
        const calls = [
            () => bdb.createProduct({}, newProduct()),
            () => bdb.getProduct({}, PRD),
            () => bdb.createAuthCode({}, newCode()),
            () => bdb.consumeAuthCode({}, { codeHash: H('c'), productId: PRD, redirectUri: URI }),
            () => bdb.createLinkWithKey({}, newLink()),
            () => bdb.getLink({}, LNK),
            () => bdb.listLinksForBot({}, BOT),
            () => bdb.revokeLink({}, { linkId: LNK, botId: BOT }),
            () => bdb.rotateLinkKey({}, { linkId: LNK, botId: BOT, keyHash: H('b') }),
            () => bdb.getLinkKeyContext({}, H('a')),
        ];
        for (const c of calls) await assert.rejects(c, bdb.BridgeDbError);
    });

    it('查詢丟錯（缺表）→ 包成 BridgeDbError', async () => {
        await d1.db.prepare('ALTER TABLE links RENAME TO links_hidden').run();
        try {
            await assert.rejects(() => bdb.getLink(env, LNK), bdb.BridgeDbError);
        } finally {
            await d1.db.prepare('ALTER TABLE links_hidden RENAME TO links').run();
        }
    });
});

describe('products', () => {
    it('createProduct 寫入，getProduct 取回（JSON 欄位解析、disabled 預設 false）；只存雜湊', async () => {
        assert.deepEqual(await bdb.createProduct(env, newProduct()), { created: true });
        const p = await bdb.getProduct(env, PRD);
        assert.deepEqual(p, {
            productId: PRD, name: 'Image Picker', secretHash: H('9'), redirectUris: [URI],
            urlDomains: ['picker.example.com'], scopes: ['link:manage', 'contacts:bind', 'messages:send'],
            disabled: false, createdAt: 1000, productKey: null,
        });
    });

    it('同 product_id 第二次 → {created:false, conflict:true}，不覆蓋', async () => {
        await bdb.createProduct(env, newProduct());
        assert.deepEqual(await bdb.createProduct(env, newProduct({ name: 'Other' })), { created: false, conflict: true });
        assert.equal((await bdb.getProduct(env, PRD)).name, 'Image Picker');
    });

    it('不存在 → null；disabled=1 → true；壞掉的 JSON 欄位當成空陣列', async () => {
        assert.equal(await bdb.getProduct(env, 'prd_none'), null);
        await d1.db.prepare("INSERT INTO products (product_id, name, secret_hash, redirect_uris, scopes, disabled, created_at) VALUES ('prd_bad','n','h','{oops','[]',1,1)").run();
        const p = await bdb.getProduct(env, 'prd_bad');
        assert.equal(p.disabled, true);
        assert.deepEqual(p.redirectUris, []);
    });

    it('SQL injection 字串只會被當資料存起來', async () => {
        const evil = "x'); DROP TABLE products;--";
        await bdb.createProduct(env, newProduct({ name: evil }));
        assert.equal((await bdb.getProduct(env, PRD)).name, evil);
        assert.equal(await count(d1.db, 'products'), 1);
    });
});

describe('auth codes', () => {
    const consume = (over = {}) => bdb.consumeAuthCode(env, { codeHash: H('c'), productId: PRD, redirectUri: URI, now: 5000, ...over });

    it('消耗成功回 bot、scopes、發碼者，並標記 used_at', async () => {
        await bdb.createAuthCode(env, newCode());
        assert.deepEqual(await consume(), { botId: BOT, scopes: ['link:manage'], createdBy: 'Uowner' });
        assert.equal((await all(d1.db, 'SELECT used_at FROM auth_codes'))[0].used_at, 5000);
    });

    it('只存雜湊：資料庫裡沒有任何看得出授權碼原文的欄位', async () => {
        await bdb.createAuthCode(env, newCode({ codeHash: H('d') }));
        const row = (await all(d1.db, 'SELECT * FROM auth_codes'))[0];
        assert.equal(row.code_hash, H('d'));
        assert.equal(row.used_at, null);
    });

    it('第二次消耗 → null（單次）', async () => {
        await bdb.createAuthCode(env, newCode());
        assert.ok(await consume());
        assert.equal(await consume(), null);
    });

    it('並行 8 個消耗，只有 1 個成功', async () => {
        await bdb.createAuthCode(env, newCode());
        const results = await Promise.all(Array.from({ length: 8 }, () => consume()));
        assert.equal(results.filter(Boolean).length, 1);
    });

    it('過期（expires_at <= now）→ null；邊界：差 1 毫秒仍有效', async () => {
        await bdb.createAuthCode(env, newCode({ expiresAt: 5000 }));
        assert.equal(await consume({ now: 5000 }), null);
        assert.equal(await consume({ now: 6000 }), null);
        await bdb.createAuthCode(env, newCode({ codeHash: H('e'), expiresAt: 5000 }));
        assert.ok(await consume({ codeHash: H('e'), now: 4999 }));
    });

    it('不存在 → null', async () => {
        assert.equal(await consume({ codeHash: H('f') }), null);
    });

    it('產品不符或 redirect_uri 差一個字元 → null，而且不會燒掉合法持有人的碼', async () => {
        await bdb.createAuthCode(env, newCode());
        assert.equal(await consume({ productId: 'prd_bbbbbbbbbbbb' }), null);
        for (const uri of [`${URI}/`, URI.toUpperCase(), `${URI}?a=1`, URI.slice(0, -1), `${URI} `, 'http://picker.example.com/cb']) {
            assert.equal(await consume({ redirectUri: uri }), null, uri);
        }
        assert.equal((await all(d1.db, 'SELECT used_at FROM auth_codes'))[0].used_at, null);
        assert.ok(await consume());
    });

    it('createAuthCode 順手清掉過期超過一小時的舊碼，其他不動', async () => {
        await bdb.createAuthCode(env, newCode({ codeHash: H('1'), expiresAt: 1000, now: 0 }));
        await bdb.createAuthCode(env, newCode({ codeHash: H('2'), expiresAt: 3_600_000, now: 0 }));
        await bdb.createAuthCode(env, newCode({ codeHash: H('3'), expiresAt: 9_000_000, now: 3_700_000 }));
        const hashes = (await all(d1.db, 'SELECT code_hash FROM auth_codes ORDER BY code_hash')).map((r) => r.code_hash);
        assert.deepEqual(hashes, [H('2'), H('3')]);
    });

    it('同一個 code_hash 發第二次 → 失敗（BridgeDbError），第一筆不受影響', async () => {
        await bdb.createAuthCode(env, newCode());
        await assert.rejects(() => bdb.createAuthCode(env, newCode({ botId: OTHER_BOT })), bdb.BridgeDbError);
        assert.equal((await all(d1.db, 'SELECT bot_id FROM auth_codes'))[0].bot_id, BOT);
    });
});

describe('createLinkWithKey', () => {
    beforeEach(async () => { await bdb.createProduct(env, newProduct()); });

    it('建立連結與第一把金鑰（金鑰 link_id 指向連結，system 欄位不可能與系統名稱相撞）', async () => {
        assert.deepEqual(await bdb.createLinkWithKey(env, newLink()), { revokedLinkIds: [] });
        const link = await bdb.getLink(env, LNK);
        assert.equal(link.status, 'active');
        assert.equal(link.productName, 'Image Picker');
        assert.deepEqual(link.scopes, ['link:manage', 'contacts:bind', 'messages:send']);
        assert.equal(link.createdBy, 'Uowner');
        const keys = await all(d1.db, 'SELECT * FROM service_keys');
        assert.equal(keys.length, 1);
        assert.equal(keys[0].key_hash, H('a'));
        assert.equal(keys[0].link_id, LNK);
        assert.equal(keys[0].system, `link:${LNK}`);
        assert.equal(keys[0].revoked_at, null);
        assert.ok(keys[0].system.includes(':'), '含 ":"，系統名稱 regex 不允許');
    });

    it('重新授權：舊連結與舊金鑰被撤銷、回報被取代的舊連結，只剩一條 active 連結與一把有效金鑰', async () => {
        await bdb.createLinkWithKey(env, newLink());
        const r = await bdb.createLinkWithKey(env, newLink({ linkId: 'lnk_bbbbbbbbbbbbbbbb', keyHash: H('b'), now: 3000 }));
        assert.deepEqual(r, { revokedLinkIds: [LNK] });
        assert.deepEqual(await all(d1.db, 'SELECT link_id, status, revoked_at FROM links ORDER BY link_id'), [
            { link_id: LNK, status: 'revoked', revoked_at: 3000 },
            { link_id: 'lnk_bbbbbbbbbbbbbbbb', status: 'active', revoked_at: null },
        ]);
        assert.deepEqual(await all(d1.db, 'SELECT key_hash, revoked_at FROM service_keys ORDER BY key_hash'), [
            { key_hash: H('a'), revoked_at: 3000 },
            { key_hash: H('b'), revoked_at: null },
        ]);
    });

    it('不同 bot、不同產品的連結不互相撤銷', async () => {
        await bdb.createProduct(env, newProduct({ productId: 'prd_bbbbbbbbbbbb', secretHash: H('8') }));
        await bdb.createLinkWithKey(env, newLink());
        await bdb.createLinkWithKey(env, newLink({ linkId: 'lnk_bbbbbbbbbbbbbbbb', botId: OTHER_BOT, keyHash: H('b') }));
        await bdb.createLinkWithKey(env, newLink({ linkId: 'lnk_cccccccccccccccc', productId: 'prd_bbbbbbbbbbbb', keyHash: H('c') }));
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 3);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 3);
    });

    it('不碰系統金鑰（link_id 為空的金鑰）', async () => {
        await seedSystem(d1.db, { botId: BOT, system: 'imgpicker' });
        await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: 'sk_system_key' });
        await bdb.createLinkWithKey(env, newLink());
        await bdb.createLinkWithKey(env, newLink({ linkId: 'lnk_bbbbbbbbbbbbbbbb', keyHash: H('b') }));
        assert.equal(await count(d1.db, 'service_keys', 'link_id IS NULL AND revoked_at IS NULL'), 1);
    });

    it('batch 失敗整批回滾：舊連結仍 active、舊金鑰仍有效、沒有新連結也沒有孤兒金鑰', async () => {
        await bdb.createLinkWithKey(env, newLink());
        await assert.rejects(
            () => bdb.createLinkWithKey({ BRIDGE_DB: failingBatchDb(d1.db) }, newLink({ linkId: 'lnk_bbbbbbbbbbbbbbbb', keyHash: H('b'), now: 3000 })),
            bdb.BridgeDbError
        );
        assert.deepEqual(await all(d1.db, 'SELECT link_id, status, revoked_at FROM links'), [{ link_id: LNK, status: 'active', revoked_at: null }]);
        assert.deepEqual(await all(d1.db, 'SELECT key_hash, revoked_at FROM service_keys'), [{ key_hash: H('a'), revoked_at: null }]);
    });

    it('金鑰雜湊重複 → 整批回滾（舊連結不被撤銷）', async () => {
        await bdb.createLinkWithKey(env, newLink());
        await assert.rejects(() => bdb.createLinkWithKey(env, newLink({ linkId: 'lnk_bbbbbbbbbbbbbbbb', now: 3000 })), bdb.BridgeDbError);
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
    });

    it('並行重新授權 6 次後，仍恰好一條 active 連結與一把有效金鑰', async () => {
        await bdb.createLinkWithKey(env, newLink());
        await Promise.allSettled(Array.from({ length: 6 }, (_, i) => bdb.createLinkWithKey(env, newLink({
            linkId: `lnk_${String(i).repeat(16)}`, keyHash: H(String(i)), now: 3000 + i,
        }))));
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
    });
});

describe('getLink / listLinksForBot', () => {
    beforeEach(async () => {
        await bdb.createProduct(env, newProduct());
        await bdb.createLinkWithKey(env, newLink());
        await bdb.createLinkWithKey(env, newLink({ linkId: 'lnk_bbbbbbbbbbbbbbbb', keyHash: H('b'), now: 3000 }));
        await bdb.createLinkWithKey(env, newLink({ linkId: 'lnk_cccccccccccccccc', botId: OTHER_BOT, keyHash: H('c'), now: 4000 }));
    });

    it('getLink：存在回完整資料，不存在 null', async () => {
        assert.equal((await bdb.getLink(env, LNK)).status, 'revoked');
        assert.equal((await bdb.getLink(env, LNK)).revokedAt, 3000);
        assert.equal(await bdb.getLink(env, 'lnk_zzzzzzzzzzzzzzzz'), null);
    });

    it('listLinksForBot：只回這個 bot 的連結（含已撤銷），新的在前', async () => {
        const list = await bdb.listLinksForBot(env, BOT);
        assert.deepEqual(list.map((l) => [l.linkId, l.status]), [['lnk_bbbbbbbbbbbbbbbb', 'active'], [LNK, 'revoked']]);
        assert.equal(list[0].productName, 'Image Picker');
        assert.deepEqual((await bdb.listLinksForBot(env, OTHER_BOT)).map((l) => l.linkId), ['lnk_cccccccccccccccc']);
        assert.deepEqual(await bdb.listLinksForBot(env, 'Unone'), []);
    });
});

describe('revokeLink', () => {
    beforeEach(async () => {
        await bdb.createProduct(env, newProduct());
        await bdb.createLinkWithKey(env, newLink());
    });

    it('撤銷連結與全部金鑰（同一批）', async () => {
        assert.equal(await bdb.revokeLink(env, { linkId: LNK, botId: BOT, now: 5000 }), true);
        assert.deepEqual(await all(d1.db, 'SELECT status, revoked_at FROM links'), [{ status: 'revoked', revoked_at: 5000 }]);
        assert.deepEqual(await all(d1.db, 'SELECT revoked_at FROM service_keys'), [{ revoked_at: 5000 }]);
    });

    it('別的 bot 撤銷不到；不存在 → false；已撤銷 → false（不覆蓋 revoked_at）', async () => {
        assert.equal(await bdb.revokeLink(env, { linkId: LNK, botId: OTHER_BOT }), false);
        assert.equal(await bdb.revokeLink(env, { linkId: 'lnk_zzzzzzzzzzzzzzzz', botId: BOT }), false);
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        assert.equal(await bdb.revokeLink(env, { linkId: LNK, botId: BOT, now: 5000 }), true);
        assert.equal(await bdb.revokeLink(env, { linkId: LNK, botId: BOT, now: 9000 }), false);
        assert.equal((await all(d1.db, 'SELECT revoked_at FROM links'))[0].revoked_at, 5000);
    });

    it('batch 失敗整批回滾：連結與金鑰都維持原狀', async () => {
        await assert.rejects(() => bdb.revokeLink({ BRIDGE_DB: failingBatchDb(d1.db) }, { linkId: LNK, botId: BOT, now: 5000 }), bdb.BridgeDbError);
        assert.equal(await count(d1.db, 'links', "status = 'active'"), 1);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
    });
});

describe('rotateLinkKey', () => {
    beforeEach(async () => {
        await bdb.createProduct(env, newProduct());
        await bdb.createLinkWithKey(env, newLink({ scopes: ['link:manage', 'messages:send'] }));
    });
    const rotate = (over = {}) => bdb.rotateLinkKey(env, { linkId: LNK, botId: BOT, keyHash: H('b'), now: 5000, ...over });

    it('撤銷舊金鑰、發新金鑰（scopes 取自連結），連結不變', async () => {
        assert.equal(await rotate(), true);
        assert.deepEqual(await all(d1.db, 'SELECT key_hash, scopes, link_id, system, revoked_at FROM service_keys ORDER BY key_hash'), [
            { key_hash: H('a'), scopes: '["link:manage","messages:send"]', link_id: LNK, system: `link:${LNK}`, revoked_at: 5000 },
            { key_hash: H('b'), scopes: '["link:manage","messages:send"]', link_id: LNK, system: `link:${LNK}`, revoked_at: null },
        ]);
        assert.equal((await bdb.getLink(env, LNK)).status, 'active');
    });

    it('別的 bot、不存在、已撤銷的連結 → false，不留孤兒金鑰', async () => {
        assert.equal(await rotate({ botId: OTHER_BOT }), false);
        assert.equal(await rotate({ linkId: 'lnk_zzzzzzzzzzzzzzzz' }), false);
        await bdb.revokeLink(env, { linkId: LNK, botId: BOT, now: 4000 });
        assert.equal(await rotate(), false);
        assert.equal(await count(d1.db, 'service_keys'), 1);
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 0);
    });

    it('並行 6 次輪替後，恰好一把有效', async () => {
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => rotate({ keyHash: H(String(i)), now: 6000 + i })));
        assert.ok(results.every((r) => r === true));
        assert.equal(await count(d1.db, 'service_keys', 'revoked_at IS NULL'), 1);
        assert.equal(await count(d1.db, 'service_keys'), 7);
    });

    it('batch 失敗整批回滾：舊金鑰仍有效、沒有新金鑰', async () => {
        await assert.rejects(() => bdb.rotateLinkKey({ BRIDGE_DB: failingBatchDb(d1.db) }, { linkId: LNK, botId: BOT, keyHash: H('b') }), bdb.BridgeDbError);
        assert.deepEqual(await all(d1.db, 'SELECT key_hash, revoked_at FROM service_keys'), [{ key_hash: H('a'), revoked_at: null }]);
    });
});

describe('getLinkKeyContext 與系統金鑰認證的隔離', () => {
    beforeEach(async () => {
        await bdb.createProduct(env, newProduct());
        await bdb.createLinkWithKey(env, newLink());
    });

    it('金鑰 → 連結 → 產品，一次查到', async () => {
        assert.deepEqual(await bdb.getLinkKeyContext(env, H('a')), {
            key: { linkId: LNK, botId: BOT, scopes: ['link:manage', 'contacts:bind', 'messages:send'], revokedAt: null },
            link: { linkId: LNK, productId: PRD, botId: BOT, scopes: ['link:manage', 'contacts:bind', 'messages:send'], status: 'active' },
            product: { disabled: false },
        });
    });

    it('查無金鑰 → null', async () => {
        assert.equal(await bdb.getLinkKeyContext(env, H('f')), null);
    });

    it('連結撤銷、產品停用、金鑰撤銷都反映在查詢結果', async () => {
        await d1.db.prepare('UPDATE products SET disabled = 1').run();
        assert.equal((await bdb.getLinkKeyContext(env, H('a'))).product.disabled, true);
        await bdb.revokeLink(env, { linkId: LNK, botId: BOT, now: 7000 });
        const ctx = await bdb.getLinkKeyContext(env, H('a'));
        assert.equal(ctx.link.status, 'revoked');
        assert.equal(ctx.key.revokedAt, 7000);
    });

    it('系統金鑰（link_id 為空）→ link 與 product 為 null，linkId 為 null', async () => {
        await seedSystem(d1.db, { botId: BOT, system: 'imgpicker' });
        await seedKey(d1.db, { botId: BOT, system: 'imgpicker', key: 'sk_sys' });
        const { sha256Hex } = await import('../../worker_src/lib/crypto_util.js');
        const ctx = await bdb.getLinkKeyContext(env, await sha256Hex('sk_sys'));
        assert.equal(ctx.key.linkId, null);
        assert.equal(ctx.link, null);
        assert.equal(ctx.product, null);
    });

    it('孤兒連結金鑰（連結列不存在）→ link 為 null', async () => {
        await d1.db.prepare("INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, link_id) VALUES (?1,?2,'link:lnk_gone','[]',1,'lnk_gone')").bind(H('9'), BOT).run();
        const ctx = await bdb.getLinkKeyContext(env, H('9'));
        assert.equal(ctx.key.linkId, 'lnk_gone');
        assert.equal(ctx.link, null);
    });

    it('getKeyWithSystem（既有系統金鑰查詢）看不到連結金鑰：回 null', async () => {
        assert.equal(await bdb.getKeyWithSystem(env, H('a')), null);
    });

    it('即使有人把連結金鑰的 (bot, system) 對上一個真的系統，getKeyWithSystem 仍回 null', async () => {
        await seedSystem(d1.db, { botId: BOT, system: 'imgpicker' });
        await d1.db.prepare("INSERT INTO service_keys (key_hash, bot_id, system, scopes, created_at, link_id) VALUES (?1,?2,'imgpicker','[\"raw:push\"]',1,?3)").bind(H('8'), BOT, LNK).run();
        assert.equal(await bdb.getKeyWithSystem(env, H('8')), null);
    });
});

describe('writeAudit 白名單（LM-2A 新欄位）', () => {
    const detailOf = async () => JSON.parse((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail);
    const write = (detail) => bdb.writeAudit(env, { actorType: 'system', actorId: 'admin_endpoint', botId: BOT, action: 'x', result: 'ok', detail });

    it('收 product_id、link_id、error_code、scopes', async () => {
        await write({ product_id: PRD, link_id: LNK, error_code: 'INVALID_CODE', scopes: ['link:manage'] });
        assert.deepEqual(await detailOf(), { product_id: PRD, link_id: LNK, error_code: 'INVALID_CODE', scopes: ['link:manage'] });
    });

    it('格式不對的一律丟掉（授權碼、金鑰、雜湊、產品密鑰、任意字串都進不去）', async () => {
        await write({
            product_id: 'bps_aaaaaaaaaaaa_' + 'x'.repeat(43), link_id: 'brk_ab12cd_' + 'x'.repeat(43), error_code: 'lmc_' + 'x'.repeat(43),
            scopes: ['bps_x'],
        });
        assert.equal((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail, null);
        await d1.reset();
        await write({ product_id: H('a'), link_id: 'lnk_' + H('a'), error_code: 'Invalid code' });
        assert.equal((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail, null);
        await d1.reset();
        await write({ product_id: 'prd_AAAAAAAAAAAA', link_id: 'lnk_abc', error_code: 'X' });
        assert.equal((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail, null);
    });

    it('型別不對（數字、物件、陣列）不收', async () => {
        await write({ product_id: 123, link_id: { a: 1 }, error_code: ['INVALID_CODE'] });
        assert.equal((await all(d1.db, 'SELECT detail FROM audit_log'))[0].detail, null);
    });
});
