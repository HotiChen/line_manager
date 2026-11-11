/**
 * Unit Tests — migration/migrate.js 的回填行為
 *
 * test_migration.mjs 守的是端點的安全性（secret、401/503）。這裡守的是資料：
 * 回填出錯的方式幾乎都不會報錯，只會安靜地讓某個使用者的資料變成舊版本。
 *
 * 四條最重要的：
 *   1. 絕不覆蓋已經存在的新 key（雙寫上線後，新 key 可能比舊 key 新）
 *   2. 只回填 handler 已經切換的資源
 *   3. 重跑結果完全相同（可重入）
 *   4. 舊 key 一筆都不能少
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockKV } from '../helpers/mock_kv.mjs';
import { BotKeys, UserKeys, V1Keys } from '../../worker_src/lib/kv_schema.js';
import { RESOURCES } from '../../worker_src/lib/bot_store.js';
import {
    migrateUser,
    migrateAll,
    migrateStatus,
    rollbackUser,
    BACKFILL_CURSOR_KEY,
} from '../../worker_src/migration/migrate.js';

const USER = 'Uowner00000000000000000000000001';
const BOT_A = 'Cbot0000000000000000000000000a';
const BOT_B = 'Cbot0000000000000000000000000b';

function createEnv() {
    return { KV_LINE_STORAGE: createMockKV() };
}

/**
 * 一個持有兩個官方帳號的 owner —— 正式環境真的有這種登入，而且是舊模型
 * 把兩邊資料混在一起的原因。
 */
async function seedTwoBotUser(env, userId = USER) {
    await env.KV_LINE_STORAGE.put(V1Keys.accessTokens(userId), JSON.stringify({
        主帳號: { token: 'tok-a', destination: BOT_A, displayName: '主帳號' },
        測試帳號: { token: 'tok-b', destination: BOT_B, displayName: '測試帳號' },
    }));
    await env.KV_LINE_STORAGE.put(V1Keys.currentToken(userId), '主帳號');
}

async function read(env, key) {
    return env.KV_LINE_STORAGE.get(key);
}

async function readJson(env, key) {
    return env.KV_LINE_STORAGE.get(key, { type: 'json' });
}

// ---------------------------------------------------------------------------

describe('migrateUser — bot 中繼資料', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedTwoBotUser(env); });

    it('要寫 bot:<id>:owner —— 舊版漏了它，resolveOwner 因此永遠走回退路徑', async () => {
        await migrateUser(env, USER);

        assert.equal(await read(env, BotKeys.owner(BOT_A)), USER);
        assert.equal(await read(env, BotKeys.owner(BOT_B)), USER);
    });

    it('每個 bot 都建 info 與 permissions', async () => {
        await migrateUser(env, USER);

        for (const botId of [BOT_A, BOT_B]) {
            const info = await readJson(env, BotKeys.info(botId));
            assert.equal(info.botId, botId);
            assert.equal(info.createdBy, USER);

            const perms = await readJson(env, BotKeys.permissions(botId));
            assert.equal(perms.users[0].userId, USER);
            assert.equal(perms.users[0].role, 'owner');
        }
    });

    it('permissions 已存在時不可覆蓋（裡面可能有受邀的同事）', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT_A), JSON.stringify({
            users: [
                { userId: USER, role: 'owner' },
                { userId: 'Ucolleague', role: 'member' },
            ],
        }));

        await migrateUser(env, USER);

        const perms = await readJson(env, BotKeys.permissions(BOT_A));
        assert.equal(perms.users.length, 2, '重設成只有 owner 等於把同事踢出去');
        assert.ok(perms.users.find(u => u.userId === 'Ucolleague'));
    });

    it('force 也不可覆蓋 permissions', async () => {
        await env.KV_LINE_STORAGE.put(BotKeys.permissions(BOT_A), JSON.stringify({
            users: [{ userId: 'Ucolleague', role: 'member' }],
        }));

        await migrateUser(env, USER, { force: true });

        const perms = await readJson(env, BotKeys.permissions(BOT_A));
        assert.equal(perms.users[0].userId, 'Ucolleague');
    });

    it('user:bots 已存在時只補缺的 bot，不動 currentBotId', async () => {
        // 使用者自己在後台切到了測試帳號 —— 那比 current_token 新
        await env.KV_LINE_STORAGE.put(UserKeys.bots(USER), JSON.stringify({
            bots: [{ botId: BOT_B, role: 'owner' }],
            currentBotId: BOT_B,
        }));

        await migrateUser(env, USER);

        const userBots = await readJson(env, UserKeys.bots(USER));
        assert.equal(userBots.currentBotId, BOT_B, '使用者自己選的 bot 不可被回填改掉');
        assert.deepEqual(userBots.bots.map(b => b.botId).sort(), [BOT_A, BOT_B].sort());
    });

    it('沒有 destination 的 project 要明確說無法回填，而不是安靜跳過', async () => {
        const bare = createEnv();
        await bare.KV_LINE_STORAGE.put(V1Keys.accessTokens(USER), JSON.stringify({
            舊專案: { token: 'tok' },
        }));

        const result = await migrateUser(bare, USER);

        assert.equal(result.success, true);
        assert.deepEqual(result.bots, []);
        assert.ok(result.logs.some(l => l.includes('destination')), '必須指出缺的是什麼');
    });
});

describe('migrateUser — 絕不覆蓋已存在的新 key', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedTwoBotUser(env); });

    it('新 key 有值時跳過，不管舊 key 是什麼', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify([{ keyword: '舊' }]));
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT_A), JSON.stringify([{ keyword: '使用者剛改的' }]));

        const result = await migrateUser(env, USER);

        assert.deepEqual(
            await readJson(env, BotKeys.keywords(BOT_A)),
            [{ keyword: '使用者剛改的' }],
            '覆蓋等於把使用者剛改的東西換回舊版本'
        );
        assert.ok(result.counts.skipped_exists > 0);
    });

    it('force=true 才會覆蓋', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify([{ keyword: '舊' }]));
        await env.KV_LINE_STORAGE.put(BotKeys.keywords(BOT_A), JSON.stringify([{ keyword: '新' }]));

        await migrateUser(env, USER, { force: true });

        assert.deepEqual(await readJson(env, BotKeys.keywords(BOT_A)), [{ keyword: '舊' }]);
    });

    it('舊 key 沒有資料時不會寫出一個空的新 key', async () => {
        await migrateUser(env, USER);
        assert.equal(await read(env, BotKeys.keywords(BOT_A)), null);
    });
});

describe('migrateUser — 只回填已切換的資源', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedTwoBotUser(env); });

    it('已切換的資源會被複製', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify([{ keyword: 'A' }]));
        await env.KV_LINE_STORAGE.put(V1Keys.imagemap(USER), JSON.stringify([{ name: 'm' }]));

        await migrateUser(env, USER);

        assert.deepEqual(await readJson(env, BotKeys.keywords(BOT_A)), [{ keyword: 'A' }]);
        assert.deepEqual(await readJson(env, BotKeys.imagemaps(BOT_A)), [{ name: 'm' }]);
    });

    it('還沒切換的資源不可被回填', async () => {
        // 單筆 flex 是比 flexList 更早的格式，沒有任何程式讀寫它，所以刻意
        // 不標 switched。提前回填會留下一個沒人讀、卻在它切換那一刻立刻
        // 生效的舊快照。
        assert.equal(RESOURCES.flex.switched, false, '這個測試的前提');

        await env.KV_LINE_STORAGE.put(V1Keys.flex(USER, 'f-old'), JSON.stringify({ name: '舊格式' }));
        await migrateUser(env, USER);

        assert.equal(await read(env, BotKeys.flex(BOT_A, 'f-old')), null);
    });

    it('已切換的資源清單與 RESOURCES 一致，沒有漏掉任何一個', async () => {
        // 這個斷言的用途是：有人把某個資源標成 switched 卻忘了讓回填支援它的
        // id 形狀時，會在這裡被抓到，而不是在 prod 上少搬一批資料。
        const switched = Object.entries(RESOURCES).filter(([, s]) => s.switched);

        for (const [name, spec] of switched) {
            if (spec.args >= 2) {
                assert.ok(
                    Array.isArray(spec.entityTypes),
                    `${name} 需要 ${spec.args} 個 id，必須提供 entityTypes 才能被列舉回填`
                );
            }
        }
        assert.ok(switched.length > 0);
    });

    it('回報哪些資源被刻意跳過', async () => {
        const result = await migrateUser(env, USER);
        assert.ok(result.logs.some(l => l.includes('尚未切換')));
    });
});

describe('migrateUser — copy 策略', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedTwoBotUser(env); });

    it("copy:'all' 的設定類資源進每一個 bot", async () => {
        assert.equal(RESOURCES.keywords.copy, 'all');
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify([{ keyword: 'A' }]));

        await migrateUser(env, USER);

        assert.ok(await read(env, BotKeys.keywords(BOT_A)));
        assert.ok(await read(env, BotKeys.keywords(BOT_B)));
    });

    it("copy:'current' 的資源只進 current bot（避免幽靈會員）", async () => {
        assert.equal(RESOURCES.members.copy, 'current', '這個測試的前提');

        await env.KV_LINE_STORAGE.put(V1Keys.memberList(USER), JSON.stringify(['U-1', 'U-2']));
        await env.KV_LINE_STORAGE.put(V1Keys.memberProfile(USER, 'U-1'), JSON.stringify({ memberId: 'U-1' }));

        await migrateUser(env, USER);

        // current 是 BOT_A（current_token = 主帳號）
        assert.deepEqual(await readJson(env, BotKeys.members(BOT_A)), ['U-1', 'U-2']);
        assert.equal(
            await read(env, BotKeys.members(BOT_B)), null,
            '複製到每個 bot 會讓同一批會員在每個帳號底下各出現一次'
        );
        assert.ok(await read(env, BotKeys.member(BOT_A, 'U-1')));
        assert.equal(await read(env, BotKeys.member(BOT_B, 'U-1')), null);
    });

    it('標籤反向索引（雙 id）也要被回填', async () => {
        assert.equal(RESOURCES.tagEntities.args, 2, '這個測試的前提');

        await env.KV_LINE_STORAGE.put(V1Keys.tagEntities(USER, 'member', 'VIP'), JSON.stringify(['U-1']));
        await env.KV_LINE_STORAGE.put(V1Keys.tagEntities(USER, 'keyword', '營業時間'), JSON.stringify(['k-1']));

        await migrateUser(env, USER);

        assert.deepEqual(await readJson(env, BotKeys.tagEntities(BOT_A, 'member', 'VIP')), ['U-1']);
        assert.deepEqual(await readJson(env, BotKeys.tagEntities(BOT_A, 'keyword', '營業時間')), ['k-1']);
    });
});

describe('migrateUser — 可重入', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedTwoBotUser(env); });

    it('跑兩次的結果完全相同', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify([{ keyword: 'A' }]));
        await env.KV_LINE_STORAGE.put(V1Keys.flexList(USER), JSON.stringify([{ id: 'f1' }]));

        await migrateUser(env, USER);
        const after1 = new Map(env.KV_LINE_STORAGE._store);

        await migrateUser(env, USER);
        const after2 = env.KV_LINE_STORAGE._store;

        assert.equal(after2.size, after1.size, '重跑不可長出新的 key');
        for (const [key, entry] of after1) {
            // user:bots 帶 joinedAt 時間戳，只比對 bot 清單本身
            if (key === UserKeys.bots(USER)) continue;
            assert.equal(after2.get(key).value, entry.value, `${key} 在重跑後被改掉了`);
        }
    });

    it('重跑不會讓 flex 清單變成兩份（舊版每次都配新 id）', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.flexList(USER), JSON.stringify([{ id: 'f1', name: 'A' }]));

        await migrateUser(env, USER);
        await migrateUser(env, USER);

        assert.deepEqual(await readJson(env, BotKeys.flexList(BOT_A)), [{ id: 'f1', name: 'A' }]);
    });

    it('舊 key 一筆都不能動（複製，不是搬移）', async () => {
        const legacy = {
            [V1Keys.keywordReplyList(USER)]: JSON.stringify([{ keyword: 'A' }]),
            [V1Keys.flexList(USER)]: JSON.stringify([{ id: 'f1' }]),
            [V1Keys.imagemap(USER)]: JSON.stringify([{ name: 'm' }]),
        };
        for (const [k, v] of Object.entries(legacy)) {
            await env.KV_LINE_STORAGE.put(k, v);
        }

        await migrateUser(env, USER);

        for (const [k, v] of Object.entries(legacy)) {
            assert.equal(await read(env, k), v, `${k} 被動過了 —— 回滾就回不去了`);
        }
    });
});

describe('migrateAll — 可中斷可重跑', () => {
    let env;

    beforeEach(async () => {
        env = createEnv();
        for (let i = 0; i < 7; i++) {
            const userId = `Uuser${String(i).padStart(2, '0')}`;
            await env.KV_LINE_STORAGE.put(V1Keys.accessTokens(userId), JSON.stringify({
                proj: { token: 't', destination: `Cbot${i}`, displayName: 'B' },
            }));
            await env.KV_LINE_STORAGE.put(V1Keys.currentToken(userId), 'proj');
            await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(userId), JSON.stringify([{ keyword: `k${i}` }]));
        }
    });

    it('分批處理，游標留在 KV 裡', async () => {
        const first = await migrateAll(env, { batchSize: 3 });

        assert.equal(first.processed, 3);
        assert.equal(first.done, false);
        assert.ok(await read(env, BACKFILL_CURSOR_KEY), '游標必須被存下來才能續跑');
    });

    it('重複呼叫直到 done，每個使用者都被處理到', async () => {
        let guard = 0;
        let done = false;
        while (!done && guard < 20) {
            const result = await migrateAll(env, { batchSize: 3 });
            done = result.done;
            guard += 1;
        }

        assert.equal(done, true);
        for (let i = 0; i < 7; i++) {
            assert.ok(
                await read(env, BotKeys.keywords(`Cbot${i}`)),
                `Uuser${String(i).padStart(2, '0')} 沒有被回填到`
            );
        }
    });

    it('全部完成後游標會被清掉（下一次是全新一輪）', async () => {
        let guard = 0;
        while (guard < 20) {
            const result = await migrateAll(env, { batchSize: 10 });
            if (result.done) break;
            guard += 1;
        }
        assert.equal(await read(env, BACKFILL_CURSOR_KEY), null);
    });

    it('restart 忽略既有游標，從頭重跑', async () => {
        await migrateAll(env, { batchSize: 2 });
        const cursorBefore = await read(env, BACKFILL_CURSOR_KEY);
        assert.ok(cursorBefore);

        const restarted = await migrateAll(env, { batchSize: 2, restart: true });
        assert.equal(restarted.results[0].userId, 'Uuser00', 'restart 必須回到第一個使用者');
    });
});

describe('migrateStatus', () => {
    it('回報使用者數、是否在進行中，以及切換進度', async () => {
        const env = createEnv();
        await seedTwoBotUser(env, 'Ua');
        await seedTwoBotUser(env, 'Ub');

        const status = await migrateStatus(env);

        assert.equal(status.users, 2);
        assert.equal(status.inProgress, false);
        assert.ok(status.switchedResources.includes('keywords'));
        assert.ok(status.switchedResources.includes('members'));
        assert.ok(status.pendingResources.includes('flex'));
    });

    it('有游標時 inProgress 為真', async () => {
        const env = createEnv();
        await env.KV_LINE_STORAGE.put(BACKFILL_CURSOR_KEY, 'some-cursor');
        const status = await migrateStatus(env);
        assert.equal(status.inProgress, true);
    });
});

describe('rollbackUser', () => {
    let env;
    beforeEach(async () => { env = createEnv(); await seedTwoBotUser(env); });

    it('刪掉 bot 命名空間的全部 key，包含後來新增的資源', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify([{ keyword: 'A' }]));
        await migrateUser(env, USER);
        // 模擬一個「列舉式回滾會漏掉」的資源
        await env.KV_LINE_STORAGE.put(BotKeys.tierConfig(BOT_A), JSON.stringify({ tiers: [] }));

        await rollbackUser(env, USER);

        const leftover = [...env.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith('bot:'));
        assert.deepEqual(leftover, [], '一個一個列舉的回滾每次新增資源就會漏一個');
    });

    it('舊 key 不受影響，系統回滾後仍可用', async () => {
        await env.KV_LINE_STORAGE.put(V1Keys.keywordReplyList(USER), JSON.stringify([{ keyword: 'A' }]));
        await migrateUser(env, USER);
        await rollbackUser(env, USER);

        assert.deepEqual(await readJson(env, V1Keys.keywordReplyList(USER)), [{ keyword: 'A' }]);
        assert.ok(await read(env, V1Keys.accessTokens(USER)));
    });

    it('user 命名空間也要清掉', async () => {
        await migrateUser(env, USER);
        await rollbackUser(env, USER);

        assert.equal(await read(env, UserKeys.bots(USER)), null);
        assert.equal(await read(env, UserKeys.profile(USER)), null);
    });

    it('即使 user:bots 已被刪掉，也要從 access_tokens 找出要清的 bot', async () => {
        await migrateUser(env, USER);
        await env.KV_LINE_STORAGE.delete(UserKeys.bots(USER));

        await rollbackUser(env, USER);

        const leftover = [...env.KV_LINE_STORAGE._store.keys()].filter(k => k.startsWith('bot:'));
        assert.deepEqual(leftover, []);
    });

    it('沒有 bot 時不丟錯', async () => {
        const bare = createEnv();
        const result = await rollbackUser(bare, USER);
        assert.equal(result.success, true);
    });
});

// ---------------------------------------------------------------------------

/**
 * 以下這組守的是「程式正確但跑不完」。
 *
 * 正式環境有一個 owner 名下 845 位會員。帶 id 的資源原本是逐筆
 * 「列舉 → 讀目標 → 讀來源 → 寫入」，845 筆就是約 2500 次 KV 操作，而
 * Cloudflare 付費方案的 subrequest 上限是每個請求 1000 次。結果是那個
 * owner 每次都在同一個地方被切斷，而且因為回填本身是冪等的，重跑會重新
 * 付一次「讀目標」的代價，所以永遠跑不完。
 *
 * 小資料量的測試量不到這件事，所以這裡直接灌 900 筆並對操作次數下斷言。
 */
describe('migrateUser — 大量會員不可超出 Worker 的 subrequest 上限', () => {
    /** Cloudflare 付費方案：每個請求 1000 次 subrequest。KV 操作計入。 */
    const SUBREQUEST_LIMIT = 1000;
    const MEMBER_COUNT = 900;

    let env;

    beforeEach(async () => {
        env = createEnv();
        await env.KV_LINE_STORAGE.put(V1Keys.accessTokens(USER), JSON.stringify({
            主帳號: { token: 'tok-a', destination: BOT_A, displayName: '主帳號' },
        }));
        await env.KV_LINE_STORAGE.put(V1Keys.currentToken(USER), '主帳號');

        for (let i = 0; i < MEMBER_COUNT; i++) {
            const lineUserId = `U${String(i).padStart(31, '0')}`;
            await env.KV_LINE_STORAGE.put(
                V1Keys.memberProfile(USER, lineUserId),
                JSON.stringify({ lineUserId, displayName: `會員${i}` }),
            );
        }
        env.KV_LINE_STORAGE._resetOps();
    });

    /** `bot:<id>:member:` —— assertComponent 不收空字串，所以借一個字再切掉 */
    const memberPrefix = BotKeys.member(BOT_A, 'X').slice(0, -1);

    function copiedMembers() {
        return [...env.KV_LINE_STORAGE._store.keys()]
            .filter(k => k.startsWith(memberPrefix)).length;
    }

    it('單次呼叫不得超過 subrequest 上限', async () => {
        await migrateUser(env, USER);
        assert.ok(
            env.KV_LINE_STORAGE._ops.total < SUBREQUEST_LIMIT,
            `單次回填用掉 ${env.KV_LINE_STORAGE._ops.total} 次 KV 操作，超過上限 ${SUBREQUEST_LIMIT}`,
        );
    });

    it('沒做完要明確回報 done:false 與剩餘筆數', async () => {
        const result = await migrateUser(env, USER);
        assert.equal(result.done, false, '預算用完卻回報做完了，呼叫端不會知道要再跑一次');
        assert.ok(result.remaining > 0, `remaining 應為正數，實際 ${result.remaining}`);
    });

    it('重跑會接著做，最後全部 900 筆都在新命名空間', async () => {
        let done = false;
        let rounds = 0;
        while (!done) {
            const result = await migrateUser(env, USER);
            done = result.done;
            rounds += 1;
            assert.ok(rounds <= 20, '跑了 20 輪還沒完，等於沒有前進');
        }
        assert.equal(copiedMembers(), MEMBER_COUNT);
    });

    it('每一輪都不可超過上限（不只第一輪）', async () => {
        let done = false;
        let rounds = 0;
        while (!done) {
            env.KV_LINE_STORAGE._resetOps();
            done = (await migrateUser(env, USER)).done;
            rounds += 1;
            assert.ok(
                env.KV_LINE_STORAGE._ops.total < SUBREQUEST_LIMIT,
                `第 ${rounds} 輪用掉 ${env.KV_LINE_STORAGE._ops.total} 次操作`,
            );
            assert.ok(rounds <= 20, '跑了 20 輪還沒完，等於沒有前進');
        }
    });

    it('已複製過的部分不可逐筆再讀一次 —— 否則輪數越多越貴，無法收斂', async () => {
        await migrateUser(env, USER);          // 第一輪：複製了一部分
        const firstRoundCopied = copiedMembers();
        assert.ok(firstRoundCopied > 0);

        env.KV_LINE_STORAGE._resetOps();
        await migrateUser(env, USER);          // 第二輪
        const secondRoundCopied = copiedMembers() - firstRoundCopied;

        // 第二輪自己複製的那些筆，每筆本來就要讀一次來源 —— 那是真工作。
        // 要守的是「跳過前一輪那 firstRoundCopied 筆是免費的」：如果跳過也要
        // 各付一次 get，次數會是 secondRoundCopied + firstRoundCopied，
        // 於是每一輪的有效預算越來越小，最後永遠跑不完。
        const overhead = env.KV_LINE_STORAGE._ops.get - secondRoundCopied;
        assert.ok(
            overhead < firstRoundCopied,
            `第二輪複製 ${secondRoundCopied} 筆卻花了 ${env.KV_LINE_STORAGE._ops.get} 次 get，`
            + `多出的 ${overhead} 次接近前一輪的 ${firstRoundCopied} 筆 —— 跳過的成本累積了`,
        );
    });

    it('全部做完之後再跑一次是幾乎零成本的 no-op', async () => {
        let done = false;
        let rounds = 0;
        while (!done) {
            done = (await migrateUser(env, USER)).done;
            rounds += 1;
            assert.ok(rounds <= 20, '跑了 20 輪還沒完，等於沒有前進');
        }

        env.KV_LINE_STORAGE._resetOps();
        const result = await migrateUser(env, USER);

        assert.equal(result.done, true);
        assert.equal(copiedMembers(), MEMBER_COUNT, '收斂後重跑不可改變結果');
        assert.ok(
            env.KV_LINE_STORAGE._ops.put <= 2,
            `收斂後重跑寫了 ${env.KV_LINE_STORAGE._ops.put} 次，應該幾乎不寫`,
        );
    });

    it('migrateAll 遇到沒做完的使用者不可前進游標', async () => {
        const result = await migrateAll(env, { batchSize: 10 });

        assert.equal(result.done, false, '使用者還沒回填完，整批不算完成');
        assert.equal(
            await read(env, BACKFILL_CURSOR_KEY), null,
            '游標前進（或被刪掉）會讓這個使用者剩下的會員永遠不被回填',
        );
    });
});
