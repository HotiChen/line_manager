/**
 * Unit Tests — lib/channel_secret.js（每個 bot 自己的 LINE channel secret）
 *
 * 為什麼存在：webhook 簽章密鑰原本只有一個全域 LINE_CHANNEL_SECRET，但每個 LINE channel
 * 的 secret 都不同，所以只有那一個官方帳號的 webhook 驗得過，其他一律 401。
 *
 * 安全性質：
 *   - 加密存放（AES-GCM，沿用 token_crypto），KV 裡不得出現明文
 *   - 格式驗證：LINE channel secret 是 32 位十六進位
 *   - 缺加密金鑰時拒絕儲存，不降級存明文
 *   - 讀取失敗（損毀、金鑰換了）回 null，不丟例外 —— webhook 路徑不可因此變成 500
 *   - 不覆蓋同一筆 credential 裡的其他欄位
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys } from '../../worker_src/lib/kv_schema.js';
import {
    isValidChannelSecret,
    saveChannelSecret,
    getChannelSecret,
    hasChannelSecret,
} from '../../worker_src/lib/channel_secret.js';

const BOT = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = '0123456789abcdef0123456789abcdef';

let env;
beforeEach(() => {
    env = { KV_LINE_STORAGE: createMockKV(), TOKEN_ENCRYPTION_KEY: KEY };
});

describe('isValidChannelSecret', () => {
    it('32 位十六進位（大小寫皆可）', () => {
        assert.equal(isValidChannelSecret(SECRET), true);
        assert.equal(isValidChannelSecret(SECRET.toUpperCase()), true);
    });

    for (const bad of ['', 'abc', SECRET.slice(1), SECRET + '0', 'g'.repeat(32), ' ' + SECRET.slice(1), null, undefined, 123, {}]) {
        it(`拒絕 ${JSON.stringify(bad)}`, () => {
            assert.equal(isValidChannelSecret(bad), false);
        });
    }
});

describe('saveChannelSecret / getChannelSecret', () => {
    it('存了讀得回來', async () => {
        await saveChannelSecret(env, BOT, SECRET);
        assert.equal(await getChannelSecret(env, BOT), SECRET);
        assert.equal(await hasChannelSecret(env, BOT), true);
    });

    it('KV 裡不是明文', async () => {
        await saveChannelSecret(env, BOT, SECRET);
        const raw = await env.KV_LINE_STORAGE.get(BotKeys.credential(BOT));
        assert.ok(!raw.includes(SECRET), `KV 裡是明文：${raw}`);
        assert.ok(raw.includes('enc.v1.'));
    });

    it('存在 bot 命名空間底下（BotKeys.credential），租戶刪除時一併清掉', async () => {
        await saveChannelSecret(env, BOT, SECRET);
        const keys = [...env.KV_LINE_STORAGE._store.keys()];
        assert.deepEqual(keys, [BotKeys.credential(BOT)]);
        assert.ok(keys[0].startsWith(BotKeys.prefix(BOT)));
    });

    it('不同 bot 各自一份，互不影響', async () => {
        const OTHER = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';
        await saveChannelSecret(env, BOT, SECRET);
        await saveChannelSecret(env, OTHER, 'f'.repeat(32));
        assert.equal(await getChannelSecret(env, BOT), SECRET);
        assert.equal(await getChannelSecret(env, OTHER), 'f'.repeat(32));
    });

    it('重存會覆蓋舊值', async () => {
        await saveChannelSecret(env, BOT, SECRET);
        await saveChannelSecret(env, BOT, 'a'.repeat(32));
        assert.equal(await getChannelSecret(env, BOT), 'a'.repeat(32));
    });

    it('不覆蓋同一筆 credential 裡的其他欄位', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.credential(BOT), JSON.stringify({ displayName: '某官方帳號', other: 1 }));
        await saveChannelSecret(env, BOT, SECRET);
        const stored = JSON.parse(await env.KV_LINE_STORAGE.get(BotKeys.credential(BOT)));
        assert.equal(stored.displayName, '某官方帳號');
        assert.equal(stored.other, 1);
    });

    it('格式不合法 → 丟錯，且什麼都不寫', async () => {
        await assert.rejects(() => saveChannelSecret(env, BOT, 'not-a-secret'), /channel secret/i);
        assert.equal(env.KV_LINE_STORAGE._store.size, 0);
    });

    it('缺加密金鑰 → 丟錯，不降級存明文', async () => {
        await assert.rejects(() => saveChannelSecret({ KV_LINE_STORAGE: env.KV_LINE_STORAGE }, BOT, SECRET));
        assert.equal(env.KV_LINE_STORAGE._store.size, 0);
    });

    it('botId 含 ":" → 丟錯（不可寫到別人的命名空間）', async () => {
        await assert.rejects(() => saveChannelSecret(env, 'bot:evil', SECRET), /invalid key component/);
    });
});

describe('getChannelSecret — 讀不到就是 null，不丟例外', () => {
    it('沒設定過', async () => {
        assert.equal(await getChannelSecret(env, BOT), null);
        assert.equal(await hasChannelSecret(env, BOT), false);
    });

    it('credential 存在但沒有 channelSecret', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.credential(BOT), JSON.stringify({ displayName: 'x' }));
        assert.equal(await getChannelSecret(env, BOT), null);
    });

    it('資料損毀（不是 JSON）', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.credential(BOT), '{nope');
        assert.equal(await getChannelSecret(env, BOT), null);
    });

    it('密文被竄改', async () => {
        await saveChannelSecret(env, BOT, SECRET);
        const rec = JSON.parse(await env.KV_LINE_STORAGE.get(BotKeys.credential(BOT)));
        rec.channelSecret = rec.channelSecret.slice(0, -4) + 'AAAA';
        await env.KV_LINE_STORAGE.put(BotKeys.credential(BOT), JSON.stringify(rec));
        assert.equal(await getChannelSecret(env, BOT), null);
    });

    it('加密金鑰換了（解不開）', async () => {
        await saveChannelSecret(env, BOT, SECRET);
        const other = { ...env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
        assert.equal(await getChannelSecret(other, BOT), null);
    });

    it('botId 不合法 / 空 → null', async () => {
        assert.equal(await getChannelSecret(env, 'bot:evil'), null);
        assert.equal(await getChannelSecret(env, ''), null);
        assert.equal(await getChannelSecret(env, undefined), null);
    });

    it('沒有 KV binding → null', async () => {
        assert.equal(await getChannelSecret({}, BOT), null);
    });
});
