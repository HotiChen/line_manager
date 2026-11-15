/**
 * Unit Tests — kv_schema 的橋接 API key
 *
 * 新增的 key 家族：
 *   bot:${botId}:system:${system}              系統註冊紀錄
 *   bot:${botId}:systems                       該 bot 的系統清單（索引）
 *   bot:${botId}:idem:${system}:${keyHash}     冪等紀錄
 *   bot:${botId}:quota:${period}               額度快取
 *   bot:${botId}:sys_rl:${system}:${window}    系統限流桶
 *   service_key:${sha256hex}                   全域：由 key 雜湊反查 (botId, system)
 *
 * 重點：呼叫端給的字串（system 名、冪等鍵）一律不可夾 ':' 去偽造別人的 key。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const HASH = 'a'.repeat(64);

async function load() {
    return import('../../worker_src/lib/kv_schema.js');
}

describe('BotKeys — 橋接 API', () => {
    it('system / systems / quota 形狀', async () => {
        const { BotKeys } = await load();
        assert.equal(BotKeys.system(BOT, 'imgpicker'), `bot:${BOT}:system:imgpicker`);
        assert.equal(BotKeys.systems(BOT), `bot:${BOT}:systems`);
        assert.equal(BotKeys.quota(BOT, '202611'), `bot:${BOT}:quota:202611`);
    });

    it('idem 帶 system 與雜湊後的鍵', async () => {
        const { BotKeys } = await load();
        assert.equal(BotKeys.idem(BOT, 'imgpicker', HASH), `bot:${BOT}:idem:imgpicker:${HASH}`);
    });

    it('systemRateLimit 帶 system 與時間窗', async () => {
        const { BotKeys } = await load();
        assert.equal(BotKeys.systemRateLimit(BOT, 'imgpicker', 12345), `bot:${BOT}:sys_rl:imgpicker:12345`);
    });

    it('全部都在 BotKeys.prefix 之下（租戶匯出／刪除才不會漏）', async () => {
        const { BotKeys } = await load();
        const prefix = BotKeys.prefix(BOT);
        for (const key of [
            BotKeys.system(BOT, 's'),
            BotKeys.systems(BOT),
            BotKeys.idem(BOT, 's', HASH),
            BotKeys.quota(BOT, '202611'),
            BotKeys.systemRateLimit(BOT, 's', 1),
        ]) {
            assert.ok(key.startsWith(prefix), key);
        }
    });

    it('system 名含 ":" 時拒絕', async () => {
        const { BotKeys } = await load();
        assert.throws(() => BotKeys.system(BOT, 'a:b'), /invalid key component/);
        assert.throws(() => BotKeys.idem(BOT, 'a:b', HASH), /invalid key component/);
        assert.throws(() => BotKeys.systemRateLimit(BOT, 'a:b', 1), /invalid key component/);
    });

    it('冪等鍵未經雜湊（含 ":"）時拒絕', async () => {
        const { BotKeys } = await load();
        assert.throws(() => BotKeys.idem(BOT, 's', 'deliver:project_8821:v2'), /invalid key component/);
    });

    it('空值拒絕', async () => {
        const { BotKeys } = await load();
        assert.throws(() => BotKeys.system(BOT, ''), /invalid key component/);
        assert.throws(() => BotKeys.idem(BOT, 's', ''), /invalid key component/);
    });
});

describe('ServiceKeyKeys — 全域 service key 索引', () => {
    it('形狀是 service_key:<sha256hex>', async () => {
        const { ServiceKeyKeys, KV_PREFIX } = await load();
        assert.equal(KV_PREFIX.SERVICE_KEY, 'service_key');
        assert.equal(ServiceKeyKeys.byHash(HASH), `service_key:${HASH}`);
    });

    it('只收 64 位小寫 hex，擋掉原文 key 被誤當雜湊', async () => {
        const { ServiceKeyKeys } = await load();
        assert.throws(() => ServiceKeyKeys.byHash('sk_plaintextkey'), /invalid key component/);
        assert.throws(() => ServiceKeyKeys.byHash('A'.repeat(64)), /invalid key component/);
        assert.throws(() => ServiceKeyKeys.byHash('a'.repeat(63)), /invalid key component/);
        assert.throws(() => ServiceKeyKeys.byHash(''), /invalid key component/);
    });
});
