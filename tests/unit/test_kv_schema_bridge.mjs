/**
 * Unit Tests — kv_schema 的橋接 API key
 *
 * 系統、service key、冪等紀錄現在在 D1（LM-1B），KV 只剩兩種：
 *   bot:${botId}:quota:${period}               額度快取
 *   bot:${botId}:sys_rl:${system}:${window}    系統限流桶
 *
 * 重點：呼叫端給的字串（system 名）一律不可夾 ':' 去偽造別人的 key。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';

async function load() {
    return import('../../worker_src/lib/kv_schema.js');
}

describe('BotKeys — 橋接 API', () => {
    it('quota 形狀', async () => {
        const { BotKeys } = await load();
        assert.equal(BotKeys.quota(BOT, '202611'), `bot:${BOT}:quota:202611`);
    });

    it('systemRateLimit 帶 system 與時間窗', async () => {
        const { BotKeys } = await load();
        assert.equal(BotKeys.systemRateLimit(BOT, 'imgpicker', 12345), `bot:${BOT}:sys_rl:imgpicker:12345`);
    });

    it('全部都在 BotKeys.prefix 之下（租戶匯出／刪除才不會漏）', async () => {
        const { BotKeys } = await load();
        const prefix = BotKeys.prefix(BOT);
        for (const key of [
            BotKeys.quota(BOT, '202611'),
            BotKeys.systemRateLimit(BOT, 's', 1),
        ]) {
            assert.ok(key.startsWith(prefix), key);
        }
    });

    it('system 名含 ":" 時拒絕', async () => {
        const { BotKeys } = await load();
        assert.throws(() => BotKeys.systemRateLimit(BOT, 'a:b', 1), /invalid key component/);
    });

    it('空值拒絕', async () => {
        const { BotKeys } = await load();
        assert.throws(() => BotKeys.systemRateLimit(BOT, '', 1), /invalid key component/);
    });

    it('搬到 D1 的 key 家族已不存在於 KV schema（沒有人會誤用）', async () => {
        const kv = await load();
        for (const gone of ['system', 'systems', 'idem']) assert.equal(kv.BotKeys[gone], undefined, `BotKeys.${gone}`);
        assert.equal(kv.ServiceKeyKeys, undefined);
        assert.equal(kv.KV_PREFIX.SERVICE_KEY, undefined);
    });
});
