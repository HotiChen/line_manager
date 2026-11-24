/**
 * Unit Tests — /member/save 與 botIds（LM-4C 安全審查：同 Provider 驗證靠 webhook 才會寫的 botIds）
 *
 *   - 手動儲存不接受 body 裡的 botIds（否則成員可以偽造 webhook 會員）
 *   - 手動編輯 webhook 建立的會員時，保留原本的 botIds（不會因為編輯備註就讓驗證失效）
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys } from '../../worker_src/lib/kv_schema.js';
import * as memberHandler from '../../worker_src/handler/member.js';

const OWNER = 'Uowner00000000000000000000000001';
const BOT = 'Ubot000000000000000000000000001';
const USER = 'Uline0000000000000000000000000001';

let env;
beforeEach(async () => {
    env = { KV_LINE_STORAGE: createMockKV() };
    await env.KV_LINE_STORAGE.put(UserKeys.bots(OWNER), JSON.stringify({ bots: [{ botId: BOT, role: 'owner' }], currentBotId: BOT }));
});

const save = (body) => memberHandler.route(
    new Request('https://w.example.com/member/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env, OWNER, '/member/save'
);
const stored = async () => JSON.parse(await env.KV_LINE_STORAGE.get(BotKeys.member(BOT, USER)));

describe('/member/save 與 botIds', () => {
    it('body 裡的 botIds 一律忽略（新會員不會有 botIds）', async () => {
        const r = await save({ memberId: USER, name: 'x', botIds: [BOT], source: 'webhook' });
        assert.equal(r.status, 200);
        assert.equal((await stored()).botIds, undefined);
    });

    it('編輯 webhook 建立的會員 → 保留原本的 botIds；body 想改也改不了', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.member(BOT, USER), JSON.stringify({ memberId: USER, botIds: [BOT], joinedAt: '2026-01-01T00:00:00.000Z' }));
        await save({ memberId: USER, name: '新備註', botIds: ['Uevil0000000000000000000000000001'] });
        const m = await stored();
        assert.deepEqual(m.botIds, [BOT]);
        assert.equal(m.name, '新備註');
    });
});
