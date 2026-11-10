/**
 * Unit Tests — bot_context：userId ↔ botId 的橋接
 *
 * 這是 botId 統一的關鍵零件。16 個 handler 現在收到的是 userId，
 * 要改成以 bot 為命名空間，就得先能回答兩個問題：
 *
 *   這個登入的人現在正在操作哪一個 bot？   resolveBotId(env, userId)
 *   這個 bot 是誰的？（讀舊資料要用到）     resolveOwner(env, botId)
 *
 * 兩個答案都已經存在 KV 裡，只是沒人把它們接起來：
 *   current_token_${userId}  → project 名稱
 *   access_tokens_${userId}  → { [project]: { token, destination, displayName } }
 *   destination_user_${dest} → userId        （token.js 註冊時建的反查索引）
 *
 * 新路徑（user:${userId}:bots 的 currentBotId、bot:${botId}:owner）優先，
 * 讀不到才回退舊路徑 —— 這就是雙讀的下半部。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';

const OWNER = 'Ucccccccccccccccccccccccccccccc01';
const BOT_A = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01';
const BOT_B = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02';

async function load() {
    return import('../../worker_src/lib/bot_context.js');
}

/** 直接用 put 建資料，避免依賴 mock 的私有 API */
async function seed(env, entries) {
    for (const [k, v] of Object.entries(entries)) {
        await env.KV_LINE_STORAGE.put(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
}

function freshEnv() {
    return { KV_LINE_STORAGE: createMockKV() };
}

describe('resolveBotId — 這個人現在在操作哪個 bot', () => {
    it('從舊路徑解析：current_token + access_tokens 的 destination', async () => {
        const { resolveBotId } = await load();
        const env = freshEnv();
        await seed(env, {
            [`current_token_${OWNER}`]: '熱茶測試中',
            [`access_tokens_${OWNER}`]: {
                '熱茶測試中': { token: 't1', destination: BOT_A, displayName: '熱茶測試中' },
                '熱茶小秘書': { token: 't2', destination: BOT_B, displayName: '熱茶小秘書' },
            },
        });
        assert.equal(await resolveBotId(env, OWNER), BOT_A);
    });

    it('切換 current_token 之後解析到另一個 bot', async () => {
        const { resolveBotId } = await load();
        const env = freshEnv();
        await seed(env, {
            [`current_token_${OWNER}`]: '熱茶小秘書',
            [`access_tokens_${OWNER}`]: {
                '熱茶測試中': { token: 't1', destination: BOT_A },
                '熱茶小秘書': { token: 't2', destination: BOT_B },
            },
        });
        assert.equal(await resolveBotId(env, OWNER), BOT_B);
    });

    it('新路徑優先：user:<id>:bots 的 currentBotId 勝過舊路徑', async () => {
        const { resolveBotId } = await load();
        const env = freshEnv();
        await seed(env, {
            [`user:${OWNER}:bots`]: { bots: [{ botId: BOT_B }], currentBotId: BOT_B },
            [`current_token_${OWNER}`]: '熱茶測試中',
            [`access_tokens_${OWNER}`]: { '熱茶測試中': { token: 't1', destination: BOT_A } },
        });
        assert.equal(await resolveBotId(env, OWNER), BOT_B);
    });

    it('沒有選定任何 bot 時回 null，不可亂猜', async () => {
        const { resolveBotId } = await load();
        const env = freshEnv();
        await seed(env, {
            [`access_tokens_${OWNER}`]: { '熱茶測試中': { token: 't1', destination: BOT_A } },
        });
        assert.equal(await resolveBotId(env, OWNER), null);
    });

    it('current_token 指向不存在的 project 時回 null', async () => {
        const { resolveBotId } = await load();
        const env = freshEnv();
        await seed(env, {
            [`current_token_${OWNER}`]: '已刪除的專案',
            [`access_tokens_${OWNER}`]: { '熱茶測試中': { token: 't1', destination: BOT_A } },
        });
        assert.equal(await resolveBotId(env, OWNER), null);
    });

    it('access_tokens 是舊格式（直接存字串 token、沒有 destination）時回 null 而不是崩潰', async () => {
        // token.js 自己就在防這件事（`typeof info === 'object'`），所以舊格式確實存在
        const { resolveBotId } = await load();
        const env = freshEnv();
        await seed(env, {
            [`current_token_${OWNER}`]: '舊專案',
            [`access_tokens_${OWNER}`]: { '舊專案': 'plain-token-string' },
        });
        assert.equal(await resolveBotId(env, OWNER), null);
    });

    it('完全沒有資料時回 null', async () => {
        const { resolveBotId } = await load();
        assert.equal(await resolveBotId(freshEnv(), OWNER), null);
    });

    it('userId 無效時回 null，不可丟例外到請求流程', async () => {
        const { resolveBotId } = await load();
        const env = freshEnv();
        for (const bad of [null, undefined, '', 123, 'U1:evil']) {
            assert.equal(await resolveBotId(env, bad), null, `${bad} 應回 null`);
        }
    });
});

describe('resolveOwner — 這個 bot 是誰的', () => {
    it('從舊路徑解析：destination_user_<botId>', async () => {
        const { resolveOwner } = await load();
        const env = freshEnv();
        await seed(env, { [`destination_user_${BOT_A}`]: OWNER });
        assert.equal(await resolveOwner(env, BOT_A), OWNER);
    });

    it('新路徑優先：bot:<botId>:owner 勝過舊路徑', async () => {
        const { resolveOwner } = await load();
        const env = freshEnv();
        const other = 'Ucccccccccccccccccccccccccccccc02';
        await seed(env, {
            [`bot:${BOT_A}:owner`]: other,
            [`destination_user_${BOT_A}`]: OWNER,
        });
        assert.equal(await resolveOwner(env, BOT_A), other);
    });

    it('查不到時回 null', async () => {
        const { resolveOwner } = await load();
        assert.equal(await resolveOwner(freshEnv(), BOT_A), null);
    });

    it('botId 無效時回 null', async () => {
        const { resolveOwner } = await load();
        const env = freshEnv();
        for (const bad of [null, '', 'U1:evil', 7]) {
            assert.equal(await resolveOwner(env, bad), null, `${bad} 應回 null`);
        }
    });
});

describe('listBotsOfUser — 這個人有哪些 bot', () => {
    it('從 access_tokens 列出，含 project 名稱與 displayName', async () => {
        const { listBotsOfUser } = await load();
        const env = freshEnv();
        await seed(env, {
            [`current_token_${OWNER}`]: '熱茶測試中',
            [`access_tokens_${OWNER}`]: {
                '熱茶測試中': { token: 't1', destination: BOT_A, displayName: '熱茶測試中' },
                '熱茶小秘書': { token: 't2', destination: BOT_B, displayName: '熱茶小秘書' },
            },
        });
        const bots = await listBotsOfUser(env, OWNER);
        assert.equal(bots.length, 2);
        const a = bots.find(b => b.botId === BOT_A);
        assert.equal(a.project, '熱茶測試中');
        assert.equal(a.displayName, '熱茶測試中');
        assert.equal(a.isCurrent, true);
        assert.equal(bots.find(b => b.botId === BOT_B).isCurrent, false);
    });

    it('跳過沒有 destination 的舊格式項目，不讓它變成 undefined 的 bot', async () => {
        const { listBotsOfUser } = await load();
        const env = freshEnv();
        await seed(env, {
            [`access_tokens_${OWNER}`]: {
                '好的': { token: 't1', destination: BOT_A },
                '舊格式': 'plain-token',
                '壞的': { token: 't2' },
            },
        });
        const bots = await listBotsOfUser(env, OWNER);
        assert.deepEqual(bots.map(b => b.botId), [BOT_A]);
    });

    it('沒有任何 bot 時回空陣列', async () => {
        const { listBotsOfUser } = await load();
        assert.deepEqual(await listBotsOfUser(freshEnv(), OWNER), []);
    });
});
