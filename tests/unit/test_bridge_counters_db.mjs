/**
 * Unit Tests — bridge/db.js 的原子計數與旗標（M-01／M-02，migration 0004，真 D1）
 *
 * 重點：單句 UPSERT 的上限在並行下不會被突破；固定視窗的邊界；還名額；旗標「只做一次」；
 * 機率性清理；缺 0004 的資料庫 fail-closed（BridgeDbError，不是放行）；scope_key 不含明文。
 * 沒有任何 sleep：並行用 Promise.all。
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from '../helpers/mock_d1.mjs';
import { all, count } from '../helpers/bridge_seed.mjs';
import * as bdb from '../../worker_src/bridge/db.js';

let d1;
let env;
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR); // 對齊小時的固定時間點

before(async () => { d1 = await createTestD1(); });
after(async () => { await d1.dispose(); });
beforeEach(async () => { await d1.reset(); env = { BRIDGE_DB: d1.db }; });

const take = (over = {}) => bdb.takeToken(env, { key: 'k', windowMs: MIN, cap: 3, now: T0 + 20_000, purge: false, ...over });

describe('takeToken', () => {
  it('在上限內放行並回傳取用後的數字；超過就不放行、不再增加', async () => {
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await take());
    assert.deepEqual(rs.map((r) => r.allowed), [true, true, true, false, false]);
    assert.deepEqual(rs.map((r) => r.count), [1, 2, 3, 3, 3]);
    assert.equal((await all(d1.db, 'SELECT n FROM counters'))[0].n, 3);
  });

  it('回傳視窗起點與結束時間（已對齊）', async () => {
    const r = await take({ now: T0 + 5 * MIN + 12_345 });
    assert.equal(r.window, T0 + 5 * MIN);
    assert.equal(r.resetAt, T0 + 6 * MIN);
  });

  it('固定視窗邊界：視窗最後一毫秒仍屬舊視窗，下一毫秒起是全新的桶', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await take({ now: T0 + MIN - 1 })).allowed, true);
    assert.equal((await take({ now: T0 + MIN - 1 })).allowed, false);
    const next = await take({ now: T0 + MIN });
    assert.equal(next.allowed, true);
    assert.equal(next.count, 1);
    assert.equal(await count(d1.db, 'counters'), 2);
  });

  it('不同 key 各自獨立（呼叫端的 key 本身要編入視窗大小：send:min／send:hour／send:day，同 key 不同 windowMs 可能落在同一個視窗起點）', async () => {
    for (let i = 0; i < 3; i++) await take();
    assert.equal((await take({ key: 'other' })).allowed, true);
    assert.equal((await take({ key: 'k', now: T0 + HOUR + 20_000 })).allowed, true);
  });

  it('並行 20 個、上限 7：恰好 7 個放行（單句 UPSERT 的 WHERE n < cap）', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => take({ cap: 7 })));
    assert.equal(rs.filter((r) => r.allowed).length, 7);
    assert.deepEqual(rs.filter((r) => r.allowed).map((r) => r.count).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal((await all(d1.db, 'SELECT n FROM counters'))[0].n, 7);
  });

  it('cap < 1 一律不放行，而且不寫入任何列', async () => {
    for (const cap of [0, -1]) assert.equal((await take({ cap })).allowed, false);
    assert.equal(await count(d1.db, 'counters'), 0);
  });

  it('參數不合 → BridgeDbError（不放行）', async () => {
    for (const bad of [{ key: '' }, { key: 5 }, { windowMs: 0 }, { windowMs: 1.5 }, { cap: 2.5 }, { cap: NaN }, { cap: '3' }]) {
      await assert.rejects(() => take(bad), bdb.BridgeDbError, JSON.stringify(bad));
    }
  });
});

describe('giveBackTokens', () => {
  it('還一個名額後可以再拿；n 不會低於 0；空陣列什麼都不做', async () => {
    const a = await take({ cap: 1 });
    assert.equal((await take({ cap: 1 })).allowed, false);
    await bdb.giveBackTokens(env, [{ key: 'k', window: a.window }]);
    assert.equal((await take({ cap: 1 })).allowed, true);
    await bdb.giveBackTokens(env, [{ key: 'k', window: a.window }, { key: 'k', window: a.window }, { key: 'k', window: a.window }]);
    assert.equal((await all(d1.db, 'SELECT n FROM counters'))[0].n, 0);
    await bdb.giveBackTokens(env, []);
    await bdb.giveBackTokens(env, [{ key: 'nope', window: 1 }]); // 沒有這一列：不報錯
  });
});

describe('旗標', () => {
  it('setFlag／getFlag：until_at 之前有效、之後失效；until_at 只會往後延', async () => {
    assert.equal(await bdb.getFlag(env, { key: 'f', now: T0 }), false);
    await bdb.setFlag(env, { key: 'f', untilAt: T0 + 1000 });
    assert.equal(await bdb.getFlag(env, { key: 'f', now: T0 + 999 }), true);
    assert.equal(await bdb.getFlag(env, { key: 'f', now: T0 + 1000 }), false); // until_at 本身已失效
    await bdb.setFlag(env, { key: 'f', untilAt: T0 + 500 }); // 不可縮短
    assert.equal(await bdb.getFlag(env, { key: 'f', now: T0 + 999 }), true);
    await bdb.setFlag(env, { key: 'f', untilAt: T0 + 5000 });
    assert.equal(await bdb.getFlag(env, { key: 'f', now: T0 + 4000 }), true);
  });

  it('claimFlag：沒有或已過期才搶到；並行 10 個只有 1 個贏', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => bdb.claimFlag(env, { key: 'once', untilAt: T0 + 1000, now: T0 })));
    assert.equal(rs.filter(Boolean).length, 1);
    assert.equal(await bdb.claimFlag(env, { key: 'once', untilAt: T0 + 2000, now: T0 + 999 }), false);
    assert.equal(await bdb.claimFlag(env, { key: 'once', untilAt: T0 + 3000, now: T0 + 1000 }), true); // 過期後可再搶
    assert.equal(await bdb.getFlag(env, { key: 'once', now: T0 + 2999 }), true);
  });
});

describe('清理舊視窗', () => {
  it('purge: true 刪掉超過 2 天的計數視窗與超過 1 天的過期旗標，不動新的', async () => {
    const old = T0 - 3 * 24 * HOUR;
    await take({ key: 'old', now: old });
    await take({ key: 'recent', now: T0 - HOUR });
    await bdb.setFlag(env, { key: 'oldflag', untilAt: T0 - 2 * 24 * HOUR });
    await bdb.setFlag(env, { key: 'liveflag', untilAt: T0 + HOUR });
    await take({ key: 'trigger', now: T0, purge: true });
    const keys = (await all(d1.db, 'SELECT scope_key FROM counters ORDER BY scope_key')).map((r) => r.scope_key);
    assert.deepEqual(keys, ['recent', 'trigger']);
    assert.deepEqual((await all(d1.db, 'SELECT flag_key FROM flags')).map((r) => r.flag_key), ['liveflag']);
  });

  it('purge: false 不清理；省略時只是機率性（Math.random 控制）', async () => {
    await take({ key: 'old', now: T0 - 3 * 24 * HOUR });
    await take({ key: 'x', now: T0, purge: false });
    assert.equal(await count(d1.db, 'counters'), 2);
    const real = Math.random;
    try {
      Math.random = () => 0.5;
      await take({ key: 'y', now: T0, purge: undefined });
      assert.equal(await count(d1.db, 'counters'), 3);
      Math.random = () => 0.001;
      await take({ key: 'z', now: T0, purge: undefined });
      assert.equal(await count(d1.db, 'counters'), 3); // old 被清掉，加上 z
    } finally {
      Math.random = real;
    }
  });
});

describe('缺 0004 遷移（只套用 0001～0003）→ fail-closed', () => {
  let old;
  before(async () => { old = await createTestD1({ upTo: '0003' }); });
  after(async () => { await old.dispose(); });

  it('takeToken、giveBackTokens、getFlag、setFlag、claimFlag 全部丟 BridgeDbError（不會回「放行」）', async () => {
    const e = { BRIDGE_DB: old.db };
    const realError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(() => bdb.takeToken(e, { key: 'k', windowMs: MIN, cap: 3 }), bdb.BridgeDbError);
      await assert.rejects(() => bdb.giveBackTokens(e, [{ key: 'k', window: 1 }]), bdb.BridgeDbError);
      await assert.rejects(() => bdb.getFlag(e, { key: 'k' }), bdb.BridgeDbError);
      await assert.rejects(() => bdb.setFlag(e, { key: 'k', untilAt: 5 }), bdb.BridgeDbError);
      await assert.rejects(() => bdb.claimFlag(e, { key: 'k', untilAt: 5 }), bdb.BridgeDbError);
      await assert.rejects(() => bdb.createBindCode(e, { codeHash: 'h', linkId: 'l', botId: 'b', ref: 'r', expiresAt: 9, now: 1 }), bdb.BridgeDbError);
    } finally {
      console.error = realError;
    }
  });

  it('沒有 BRIDGE_DB 綁定也一樣', async () => {
    await assert.rejects(() => bdb.takeToken({}, { key: 'k', windowMs: MIN, cap: 3 }), bdb.BridgeDbError);
    await assert.rejects(() => bdb.claimFlag({}, { key: 'k', untilAt: 5 }), bdb.BridgeDbError);
  });
});

describe('隱私與邊界', () => {
  it('takeToken 只寫 scope_key／window／n，不接受也不存任何其他欄位', async () => {
    await take({ key: 'send:hour:lnk_x:abcdef', ref: 'customer-0001', lineUserId: 'Uxxxx' });
    const cols = (await d1.db.prepare('PRAGMA table_info(counters)').all()).results.map((c) => c.name).sort();
    assert.deepEqual(cols, ['n', 'scope_key', 'window']);
    assert.ok(!JSON.stringify(await all(d1.db, 'SELECT * FROM counters')).includes('customer-0001'));
  });
});
