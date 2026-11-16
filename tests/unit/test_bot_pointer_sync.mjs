/**
 * Unit Tests — 「使用者正在操作哪個 bot」的兩個指標必須同步
 *
 * 問題：同一件事有兩個指標，而且會分岔。
 *
 *   current_token_${userId}            project 名稱。LINE API 呼叫用它取 token。
 *   user:${userId}:bots 的 currentBotId  botId。資料讀寫（openBotStore → resolveBotId）
 *                                       與 checkPermission 用它，而且優先於前者。
 *
 * 側邊欄的帳號選單只打 POST /token/set，而它原本只寫第一個。於是持有兩個
 * 官方帳號的 owner 從 A 切到 B 之後：推播用的是 B 的 token，會員/關鍵字/標籤
 * 與權限檢查卻還停在 A。
 *
 * 修法維持既有設計（currentBotId 仍是權威），由寫入端負責讓兩者一致。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { handleSetCurrentToken, handleDeleteAccessToken } from '../../worker_src/handler/token.js';
import { resolveBotId } from '../../worker_src/lib/bot_context.js';
import { getCurrentAccessToken } from '../../worker_src/lib/token_store.js';
import { checkPermission } from '../../worker_src/middleware/permission.js';
import { UserKeys, BotKeys, V1Keys } from '../../worker_src/lib/kv_schema.js';

const USER = 'Uowner001';
const BOT_A = 'Cbot_a';
const BOT_B = 'Cbot_b';
const BOT_C = 'Cbot_c';

function post(body, raw = false) {
    return new Request('http://localhost/token/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw ? body : JSON.stringify(body),
    });
}

async function readJson(env, key) {
    return env.KV_LINE_STORAGE.get(key, { type: 'json' });
}

const userBots = (env) => readJson(env, UserKeys.bots(USER));
const currentProject = (env) => env.KV_LINE_STORAGE.get(V1Keys.currentToken(USER));

/** 持有 A、B 兩個官方帳號、目前兩個指標都指向 A 的 owner */
async function seedTwoBots(env) {
    const kv = env.KV_LINE_STORAGE;
    await kv.put(V1Keys.accessTokens(USER), JSON.stringify({
        projA: { token: 'tok-a', destination: BOT_A, displayName: 'Bot A' },
        projB: { token: 'tok-b', destination: BOT_B, displayName: 'Bot B' },
    }));
    await kv.put(V1Keys.currentToken(USER), 'projA');
    await kv.put(UserKeys.bots(USER), JSON.stringify({
        bots: [{ botId: BOT_A }, { botId: BOT_B }],
        currentBotId: BOT_A,
    }));
}

describe('POST /token/set 讓 currentBotId 跟著 current_token 走', () => {
    let env;
    beforeEach(async () => {
        env = { KV_LINE_STORAGE: createMockKV() };
        await seedTwoBots(env);
    });

    it('A → B：token 與 botId 指向同一個 bot', async () => {
        const res = await handleSetCurrentToken(post({ project: 'projB' }), env, USER);
        assert.equal(res.status, 200);

        assert.equal(await getCurrentAccessToken(env, USER), 'tok-b');
        assert.equal(await resolveBotId(env, USER), BOT_B, '資料命名空間不可還停在 A');
    });

    it('A → B：checkPermission（沒有 X-Bot-Id）解析到 B', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT_B), JSON.stringify({
            users: [{ userId: USER, role: 'owner' }],
        }));

        await handleSetCurrentToken(post({ project: 'projB' }), env, USER);

        const check = await checkPermission(new Request('http://localhost/team/list'), env, USER);
        assert.equal(check.success, true);
        assert.equal(check.botId, BOT_B);
        assert.equal(check.role, 'owner');
    });

    it('切到還不在 bots 裡的 bot：補上，且不丟掉既有項目與未知欄位', async () => {
        const kv = env.KV_LINE_STORAGE;
        const tokens = await readJson(env, V1Keys.accessTokens(USER));
        tokens.projC = { token: 'tok-c', destination: BOT_C, displayName: 'Bot C' };
        await kv.put(V1Keys.accessTokens(USER), JSON.stringify(tokens));
        await kv.put(UserKeys.bots(USER), JSON.stringify({
            bots: [
                { botId: BOT_A, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z', custom: 1 },
                { botId: BOT_B, role: 'member' },
            ],
            currentBotId: BOT_A,
            futureField: { keep: true },
        }));

        await handleSetCurrentToken(post({ project: 'projC' }), env, USER);

        const after = await userBots(env);
        assert.equal(after.currentBotId, BOT_C);
        assert.deepEqual(after.futureField, { keep: true });
        assert.deepEqual(after.bots[0], { botId: BOT_A, role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z', custom: 1 });
        assert.deepEqual(after.bots[1], { botId: BOT_B, role: 'member' });
        assert.equal(after.bots.length, 3);

        // 形狀要跟 migrate.js 回填寫的一樣
        const added = after.bots[2];
        assert.deepEqual(Object.keys(added).sort(), ['botId', 'displayName', 'joinedAt', 'role']);
        assert.equal(added.botId, BOT_C);
        assert.equal(added.role, 'owner');
        assert.equal(added.displayName, 'Bot C');
        assert.ok(!Number.isNaN(Date.parse(added.joinedAt)));
    });

    it('已在 bots 裡的 bot：只改指標，不動那一筆（例如 role）', async () => {
        await env.KV_LINE_STORAGE.put(UserKeys.bots(USER), JSON.stringify({
            bots: [{ botId: BOT_A, role: 'owner' }, { botId: BOT_B, role: 'member', joinedAt: 'x' }],
            currentBotId: BOT_A,
        }));

        await handleSetCurrentToken(post({ project: 'projB' }), env, USER);

        const after = await userBots(env);
        assert.equal(after.currentBotId, BOT_B);
        assert.deepEqual(after.bots, [{ botId: BOT_A, role: 'owner' }, { botId: BOT_B, role: 'member', joinedAt: 'x' }]);
    });

    for (const [label, value] of [
        ['舊格式（token 是字串）', 'legacy-plain-token'],
        ['物件但沒有 destination', { token: 'tok-old', displayName: 'Old' }],
        ['destination 含分隔符（不可當 key 組件）', { token: 'tok-old', destination: 'bad:id' }],
    ]) {
        it(`沒有可用 destination 的專案（${label}）→ currentBotId 為 null → resolveBotId 為 null`, async () => {
            const kv = env.KV_LINE_STORAGE;
            const tokens = await readJson(env, V1Keys.accessTokens(USER));
            tokens.projOld = value;
            await kv.put(V1Keys.accessTokens(USER), JSON.stringify(tokens));

            const res = await handleSetCurrentToken(post({ project: 'projOld' }), env, USER);
            assert.equal(res.status, 200);

            assert.equal(await currentProject(env), 'projOld');
            const after = await userBots(env);
            assert.equal(after.currentBotId, null, '不可繼續指著 A');
            assert.equal(after.bots.length, 2, '清單本身不動');
            assert.equal(await resolveBotId(env, USER), null);
        });
    }

    it('A → B → A 來回切換', async () => {
        await handleSetCurrentToken(post({ project: 'projB' }), env, USER);
        await handleSetCurrentToken(post({ project: 'projA' }), env, USER);

        assert.equal(await getCurrentAccessToken(env, USER), 'tok-a');
        assert.equal(await resolveBotId(env, USER), BOT_A);
        assert.equal((await userBots(env)).bots.length, 2, '來回切換不可讓清單長出重複項目');
    });

    it('同一個 project 設兩次：第二次沒有任何 put', async () => {
        await handleSetCurrentToken(post({ project: 'projB' }), env, USER);

        env.KV_LINE_STORAGE._resetOps();
        const res = await handleSetCurrentToken(post({ project: 'projB' }), env, USER);

        assert.equal(res.status, 200);
        assert.equal(env.KV_LINE_STORAGE._ops.put, 0);
        assert.equal(env.KV_LINE_STORAGE._ops.delete, 0);
    });

    it('指標本來就一致時（初始化時的自我修復呼叫）不寫 KV', async () => {
        env.KV_LINE_STORAGE._resetOps();
        await handleSetCurrentToken(post({ project: 'projA' }), env, USER);
        assert.equal(env.KV_LINE_STORAGE._ops.put, 0);
    });

    it('已經分岔的使用者：對「目前的 project」再設一次就修好', async () => {
        // current_token = projB，但 currentBotId 還是 A —— 正式環境裡已經存在的狀態
        await env.KV_LINE_STORAGE.put(V1Keys.currentToken(USER), 'projB');
        assert.equal(await resolveBotId(env, USER), BOT_A, '前提：重現分岔');

        await handleSetCurrentToken(post({ project: 'projB' }), env, USER);

        assert.equal(await resolveBotId(env, USER), BOT_B);
    });

    it('還沒有 user:bots 的使用者（回填前）也能用，並得到正確的指標', async () => {
        await env.KV_LINE_STORAGE.delete(UserKeys.bots(USER));

        const res = await handleSetCurrentToken(post({ project: 'projB' }), env, USER);
        assert.equal(res.status, 200);

        const after = await userBots(env);
        assert.equal(after.currentBotId, BOT_B);
        assert.deepEqual(after.bots.map(b => b.botId), [BOT_B]);
        assert.equal(await resolveBotId(env, USER), BOT_B);
        assert.equal(await getCurrentAccessToken(env, USER), 'tok-b');
    });

    it('還沒有 user:bots、專案也沒有 destination：不憑空建立 user:bots', async () => {
        const kv = env.KV_LINE_STORAGE;
        await kv.delete(UserKeys.bots(USER));
        await kv.put(V1Keys.accessTokens(USER), JSON.stringify({ projOld: 'legacy-plain-token' }));

        const res = await handleSetCurrentToken(post({ project: 'projOld' }), env, USER);
        assert.equal(res.status, 200);
        assert.equal(await kv.get(UserKeys.bots(USER)), null);
        assert.equal(await resolveBotId(env, USER), null);
    });

    it('不存在的 project → 404，兩個指標都不動', async () => {
        env.KV_LINE_STORAGE._resetOps();
        const res = await handleSetCurrentToken(post({ project: 'nope' }), env, USER);

        assert.equal(res.status, 404);
        assert.equal(env.KV_LINE_STORAGE._ops.put, 0);
        assert.equal(await currentProject(env), 'projA');
        assert.equal((await userBots(env)).currentBotId, BOT_A);
    });

    it('destination 只能來自伺服器端存的 access_tokens，body 裡帶的一律忽略', async () => {
        const res = await handleSetCurrentToken(post({
            project: 'projB',
            destination: 'Cvictim',
            botId: 'Cvictim',
            currentBotId: 'Cvictim',
        }), env, USER);
        assert.equal(res.status, 200);

        const after = await userBots(env);
        assert.equal(after.currentBotId, BOT_B);
        assert.ok(!after.bots.some(b => b.botId === 'Cvictim'));
        assert.equal(await resolveBotId(env, USER), BOT_B);
    });

    it('別人的 project 名稱切不過去（access_tokens 是 per user）', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.accessTokens('Uother'), JSON.stringify({
            projVictim: { token: 'tok-v', destination: 'Cvictim' },
        }));

        const res = await handleSetCurrentToken(post({ project: 'projVictim' }), env, USER);
        assert.equal(res.status, 404);
        assert.equal((await userBots(env)).currentBotId, BOT_A);
    });

    it('壞掉的 JSON body → 400，不丟例外、不外洩 stack', async () => {
        const res = await handleSetCurrentToken(post('{not json', true), env, USER);
        assert.equal(res.status, 400);
        const text = await res.text();
        assert.ok(!/\bat\s+\S+\s+\(|SyntaxError/.test(text), text);
        assert.equal(await currentProject(env), 'projA');
    });

    for (const body of [{}, { project: '' }, { project: 42 }, { project: ['projB'] }, null]) {
        it(`缺少或非字串的 project（${JSON.stringify(body)}）→ 400`, async () => {
            const res = await handleSetCurrentToken(post(body), env, USER);
            assert.equal(res.status, 400);
            assert.equal(await currentProject(env), 'projA');
            assert.equal((await userBots(env)).currentBotId, BOT_A);
        });
    }

    it('物件原型上的名稱（__proto__、constructor）不會被當成 project', async () => {
        for (const project of ['__proto__', 'constructor', 'toString']) {
            const res = await handleSetCurrentToken(post({ project }), env, USER);
            assert.equal(res.status, 404, project);
        }
        assert.equal(await currentProject(env), 'projA');
    });
});

describe('POST /token/delete 不留下指向已刪除 bot 的 currentBotId', () => {
    let env;
    beforeEach(async () => {
        env = { KV_LINE_STORAGE: createMockKV() };
        await seedTwoBots(env);
    });

    it('刪掉目前的 project → currentBotId 清成 null', async () => {
        const res = await handleDeleteAccessToken(post({ project: 'projA' }), env, USER);
        assert.equal(res.status, 200);

        const after = await userBots(env);
        assert.equal(after.currentBotId, null);
        assert.equal(after.bots.length, 2, '只清指標，不動清單與權限（不在這次範圍）');
        assert.equal(await currentProject(env), null);
        assert.equal(await resolveBotId(env, USER), null);
    });

    it('刪掉不是目前的 project → currentBotId 不動', async () => {
        env.KV_LINE_STORAGE._resetOps();
        const res = await handleDeleteAccessToken(post({ project: 'projB' }), env, USER);
        assert.equal(res.status, 200);

        assert.equal((await userBots(env)).currentBotId, BOT_A);
        assert.equal(await currentProject(env), 'projA');
        assert.equal(await resolveBotId(env, USER), BOT_A);
        assert.equal(env.KV_LINE_STORAGE._ops.put, 1, '只寫 access_tokens');
    });

    it('沒有 user:bots 的使用者刪除時不憑空建立它', async () => {
        await env.KV_LINE_STORAGE.delete(UserKeys.bots(USER));
        const res = await handleDeleteAccessToken(post({ project: 'projA' }), env, USER);
        assert.equal(res.status, 200);
        assert.equal(await env.KV_LINE_STORAGE.get(UserKeys.bots(USER)), null);
    });
});

describe('js/main.js 初始化時的自我修復', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const src = readFileSync(join(root, 'js', 'main.js'), 'utf8');

    it('初始化的 /token/set 不再被 targetBot !== activeBot 擋住', () => {
        // 已經分岔的使用者 localStorage 與 current_token 是一致的，
        // 有這個條件就永遠不會再打一次 /token/set，指標也就永遠修不回來
        assert.doesNotMatch(src, /targetBot\s*!==?\s*activeBot/);
    });

    it('targetBot 有值時仍會打 /token/set', () => {
        const start = src.indexOf('if (targetBot) {');
        assert.ok(start >= 0, '找不到 if (targetBot) 區塊');
        const end = src.indexOf('botSelect.addEventListener', start);
        assert.ok(end > start, '找不到 change listener');
        const block = src.slice(start, end);
        assert.match(block, /api\.post\('\/token\/set',\s*\{\s*project:\s*targetBot\s*\}\)/);
        // 這個呼叫失敗（例如受邀的團隊 bot 不在 access_tokens 裡 → 404）不可讓
        // 外層 catch 接走，否則 change listener 綁不上
        assert.match(block, /try\s*\{\s*await api\.post\('\/token\/set'[^}]*\}\);?\s*\}\s*catch/);
    });
});
