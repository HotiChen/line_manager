/**
 * migrate — 把舊的 `<domain>_${userId}` 資料回填到 `bot:${botId}:<resource>`
 *
 * ## 這支程式的立場：複製，不是搬移
 *
 * 舊 key 一筆都不刪。回填完成後舊資料仍然原地不動，所以任何一步出錯都可以
 * 把 handler 退回只讀舊 key，而不需要反向搬運。刪除是整個切換的最後一步
 * （見 docs/ARCHITECTURE_PLATFORM.md 第十三節），不在這裡。
 *
 * ## 兩條不可違反的規則
 *
 * **1. 絕不覆蓋已經存在的新 key。**
 * 雙寫已經上線，所以使用者只要在回填之前動過後台，新 key 裡就是比舊 key
 * 更新的值。覆蓋它等於把使用者剛改的東西換回舊版本 —— 而且他不會收到任何
 * 提示。要強制覆蓋必須明確傳 force=1。
 *
 * **2. 只回填 handler 已經切換的資源。**
 * 哪些算切換過由 bot_store 的 RESOURCES.switched 決定。還沒切換的 handler
 * 仍然只寫舊 key；提前回填會留下一個沒人讀、卻在它切換的那一刻立刻「贏」
 * 的新 key，使用者的資料會跳回回填當時的版本。
 *
 * ## 可重入
 *
 * 搬一半中斷是常態（Worker CPU 上限、KV 抖動、手動中止）。所以：
 *
 * - 單一使用者的回填本身就是冪等的（規則 1 保證重跑不會改變結果）
 * - 整批回填把進度存在 `migration:botid:cursor`，重跑從上次的位置繼續
 * - 不產生任何隨機 id 或時間戳當資料內容 —— 舊版會在每次重跑時給 flex
 *   訊息配新的 id，跑兩次就多出一整份
 */
import { jsonResponse } from "../lib/utils.js";
import { BotKeys, UserKeys, V1Keys } from "../lib/kv_schema.js";
import { RESOURCES, USER_RESOURCES } from "../lib/bot_store.js";
import { listBotsOfUser } from "../lib/bot_context.js";

/** 整批回填的進度游標 */
export const BACKFILL_CURSOR_KEY = "migration:botid:cursor";

/** 一次 handleMigrate 呼叫最多處理幾個使用者（避免撞上 Worker 的 CPU 上限） */
const DEFAULT_BATCH_SIZE = 10;

/**
 * 一次 migrateUser 呼叫最多複製幾筆帶 id 的資源。
 *
 * Cloudflare 的 subrequest 上限是每個請求 1000 次，KV 操作計入。每筆複製是
 * 2 次操作（讀來源、寫入），加上每個資源各 2 次列舉與中繼資料的零頭，400
 * 筆約 850 次 —— 留了餘裕，因為超過上限不是變慢而是整個請求被切斷。
 *
 * 正式環境有一個 owner 名下 845 位會員，所以這不是理論問題：沒有預算的版本
 * 在那個 owner 身上量到 2732 次操作。
 */
const DEFAULT_COPY_BUDGET = 400;

async function readText(env, key) {
    try {
        return await env.KV_LINE_STORAGE.get(key);
    } catch {
        return null;
    }
}

/**
 * 複製一個 key，目標已有值時跳過。
 *
 * @returns {'copied'|'skipped_exists'|'skipped_empty'}
 */
async function copyKey(env, fromKey, toKey, force) {
    const source = await readText(env, fromKey);
    if (source === null) return "skipped_empty";

    if (!force) {
        const existing = await readText(env, toKey);
        // 規則 1：新 key 已經有值就不動它 —— 它可能比舊 key 更新
        if (existing !== null) return "skipped_exists";
    }

    await env.KV_LINE_STORAGE.put(toKey, source);
    return "copied";
}

/**
 * 這個資源在某個 bot 的新命名空間底下已經有哪些 key（完整 key 名稱）。
 *
 * 帶 id 的資源不逐筆讀目標來判斷「是否已存在」，而是整個資源前綴列舉一次。
 * 理由是收斂：逐筆讀的話，跳過一筆也要花 1 次操作，於是第 N 輪要先為前
 * N-1 輪複製過的每一筆各付一次，輪數越多能用的預算越少，到後面永遠跑不完。
 * 改成列舉之後，已完成的部分是 0 次操作，每一輪的預算都完整用在新資料上。
 *
 * 前綴取到「第一個 id 之前」，所以 args 是 1 或 2 都只需要一次列舉。
 *
 * @returns {Promise<Set<string>>} 完整 key 名稱
 */
async function listExistingKeys(env, botId, spec) {
    const probe = Array(spec.args).fill(SENTINEL);
    const prefix = spec.bot(botId, ...probe).split(SENTINEL)[0];
    const suffixes = await listSuffixes(env, prefix);
    return new Set(suffixes.map(s => prefix + s));
}

/**
 * 把一個帶 id 的資源從舊命名空間複製到新命名空間，受預算限制。
 *
 * 預算歸零之後不再複製，但仍然把剩下的筆數數完 —— 數是免費的（id 清單
 * 已經列舉過了），而呼叫端需要知道還差多少才能決定要不要再跑一輪。
 *
 * @param {{left: number, remaining: number}} budget
 * @returns {Promise<{copied: number, skipped: number}>}
 */
async function copyIndexedResource(env, userId, botId, spec, argTuples, force, budget, counts) {
    const existing = force ? new Set() : await listExistingKeys(env, botId, spec);

    let copied = 0;
    let skipped = 0;

    for (const args of argTuples) {
        let toKey;
        try {
            toKey = spec.bot(botId, ...args);
        } catch {
            // id 含有分隔符，進不了新命名空間。這是資料問題，不是預算問題，
            // 所以不佔預算也不算 pending —— 再跑幾輪都不會變。
            counts.skipped_empty += 1;
            continue;
        }

        if (existing.has(toKey)) {
            skipped += 1;
            counts.skipped_exists += 1;
            continue;
        }

        if (budget.left <= 0) {
            budget.remaining += 1;
            continue;
        }

        // 已經用列舉確認過目標不存在，所以這裡不必再讀一次目標
        const outcome = await copyKey(env, spec.v1(userId, ...args), toKey, true);
        counts[outcome] += 1;
        if (outcome === "copied") {
            copied += 1;
            budget.left -= 1;
        }
    }

    return { copied, skipped };
}

/**
 * 回填單一使用者。
 *
 * @param {Object} env
 * @param {string} userId
 * @param {{force?: boolean}} [options]
 */
export async function migrateUser(env, userId, options = {}) {
    const force = options.force === true;
    const logs = [];
    const log = (msg) => logs.push(msg);
    const counts = { copied: 0, skipped_exists: 0, skipped_empty: 0 };

    // left 歸零之後只數不複製；remaining 是「這一輪沒做到的筆數」。
    const budget = {
        left: options.budget || DEFAULT_COPY_BUDGET,
        remaining: 0,
    };

    const bots = await listBotsOfUser(env, userId);

    if (bots.length === 0) {
        // 可能是真的沒有 bot，也可能是舊 project 缺 destination（那種無法回填，
        // 因為沒有 botId 可以當命名空間）。兩者都不是錯誤，但要說清楚是哪一種。
        const accessTokens = await env.KV_LINE_STORAGE.get(V1Keys.accessTokens(userId), { type: "json" });
        const projectCount = accessTokens && typeof accessTokens === "object"
            ? Object.keys(accessTokens).length
            : 0;

        if (projectCount > 0) {
            log(`⚠️ ${userId} 有 ${projectCount} 個 project，但沒有一個帶 destination —— 無法回填。`);
            log("   請先用該 project 的 token 打 /v2/bot/info 補上 destination。");
        } else {
            log(`⚠️ ${userId} 沒有任何 project (access_tokens)，跳過。`);
        }
        return { success: true, userId, bots: [], counts, logs, done: true, remaining: 0 };
    }

    const currentBot = bots.find(b => b.isCurrent) || bots[0];
    log(`🔎 ${userId} 有 ${bots.length} 個 bot，current = ${currentBot.botId}`);

    const switched = Object.entries(RESOURCES).filter(([, spec]) => spec.switched);
    const pending = Object.entries(RESOURCES).filter(([, spec]) => !spec.switched);

    for (const bot of bots) {
        const { botId, project, displayName } = bot;
        log(`🔄 bot ${botId}（${project}）`);

        // ── bot 本身的中繼資料 ──

        // owner 是 resolveOwner 的新路徑，舊版 migration 漏了它，於是
        // resolveOwner 永遠回退到 destination_user_*
        if (force || (await readText(env, BotKeys.owner(botId))) === null) {
            await env.KV_LINE_STORAGE.put(BotKeys.owner(botId), userId);
            log("  ✅ owner");
        }

        if (force || (await readText(env, BotKeys.info(botId))) === null) {
            await env.KV_LINE_STORAGE.put(BotKeys.info(botId), JSON.stringify({
                botId,
                displayName: displayName || project,
                createdBy: userId,
                originalProjectName: project,
            }));
            log("  ✅ info");
        }

        // permissions 不可 force 覆蓋：裡面可能已經有邀請進來的同事，
        // 重設成只有 owner 等於把他們踢出去
        if ((await readText(env, BotKeys.permissions(botId))) === null) {
            await env.KV_LINE_STORAGE.put(BotKeys.permissions(botId), JSON.stringify({
                users: [{
                    userId,
                    role: "owner",
                    displayName: displayName || project,
                    addedAt: new Date().toISOString(),
                    addedBy: "system_migration",
                }],
            }));
            log("  ✅ permissions");
        } else {
            log("  ⏭️ permissions 已存在（可能已有受邀成員），不動");
        }

        // ── 資源 ──
        for (const [name, spec] of switched) {
            // copy:'current' 的資源只進 current bot。複製到每一個 bot 會讓
            // 同一批會員在每個 bot 底下各出現一次。
            if (spec.copy === "current" && botId !== currentBot.botId) continue;

            if (spec.args === 0) {
                const outcome = await copyKey(env, spec.v1(userId), spec.bot(botId), force);
                counts[outcome] += 1;
                if (outcome === "copied") log(`  ✅ ${name}`);
                else if (outcome === "skipped_exists") log(`  ⏭️ ${name}（新 key 已有較新的值）`);
                continue;
            }

            // 帶 id 的資源：先列出舊命名空間實際存在哪些 id 組合，再逐筆複製
            const argTuples = await listLegacyArgs(env, userId, spec);
            if (argTuples === null) {
                log(`  ⏭️ ${name}：需要 ${spec.args} 個 id 且沒有列舉方式，跳過`);
                continue;
            }

            const before = budget.remaining;
            const { copied, skipped } = await copyIndexedResource(
                env, userId, botId, spec, argTuples, force, budget, counts,
            );
            const deferred = budget.remaining - before;

            if (deferred > 0) {
                log(`  ⏳ ${name}：複製 ${copied}、已存在 ${skipped}、本輪預算不足 ${deferred}`);
            } else if (copied > 0) {
                log(`  ✅ ${name}（複製 ${copied}、已存在 ${skipped}）`);
            }
        }
    }

    // ── 人的資料（沒有 bot 維度）──
    for (const [name, spec] of Object.entries(USER_RESOURCES)) {
        const outcome = await copyKey(env, spec.v1(userId), spec.next(userId), force);
        counts[outcome] += 1;
        if (outcome === "copied") log(`✅ user/${name}`);
    }

    // ── user:${userId}:bots ──
    // 已存在時只補上缺的 bot，不整份覆蓋：裡面的 currentBotId 是使用者自己
    // 在後台切換的結果，比 current_token 新。
    const userBotsKey = UserKeys.bots(userId);
    const existing = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" });
    const merged = existing && Array.isArray(existing.bots)
        ? existing
        : { bots: [], currentBotId: null };

    for (const bot of bots) {
        if (!merged.bots.find(b => b.botId === bot.botId)) {
            merged.bots.push({
                botId: bot.botId,
                role: "owner",
                displayName: bot.displayName,
                joinedAt: new Date().toISOString(),
            });
        }
    }
    if (!merged.currentBotId) merged.currentBotId = currentBot.botId;

    await env.KV_LINE_STORAGE.put(userBotsKey, JSON.stringify(merged));
    log(`✅ user:bots（${merged.bots.length} 個 bot，current = ${merged.currentBotId}）`);

    if (pending.length > 0) {
        log(`ℹ️ 尚未切換、因此刻意不回填的資源：${pending.map(([n]) => n).join(", ")}`);
    }

    const done = budget.remaining === 0;

    if (done) {
        log(`🎉 ${userId} 完成：複製 ${counts.copied}、跳過（已有值）${counts.skipped_exists}、無舊資料 ${counts.skipped_empty}`);
    } else {
        log(`⏳ ${userId} 這一輪複製 ${counts.copied} 筆，還剩 ${budget.remaining} 筆 —— 再打一次同樣的網址即可接著做。`);
    }

    return {
        success: true,
        userId,
        bots: bots.map(b => b.botId),
        counts,
        logs,
        done,
        remaining: budget.remaining,
    };
}

const SENTINEL = "\u0000ID\u0000";

/** 列出某個 KV 前綴底下的全部 key，回傳去掉前綴後的尾段 */
async function listSuffixes(env, prefix) {
    const out = [];
    let cursor;
    do {
        let page;
        try {
            page = await env.KV_LINE_STORAGE.list({ prefix, cursor });
        } catch {
            return out;
        }
        for (const key of page.keys || []) {
            const suffix = key.name.slice(prefix.length);
            if (suffix !== "") out.push(suffix);
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
}

/**
 * 列出一個帶 id 的資源在舊命名空間裡實際存在哪些 id 組合。
 *
 * 單一 id 的資源直接用前綴列舉。雙 id 的 `tagEntities` 不行 —— 它的第一個
 * id（entityType）在舊 key 裡位於 userId 之前
 * （`tag_${entityType}s_${userId}_${tag}`），所以沒有單一前綴可用。
 * 那種資源在 RESOURCES 裡自己帶 `entityTypes`，這裡逐型列舉。
 *
 * @returns {Promise<Array<string[]>>|null} 每個元素是一組 args；無法列舉時回 null
 */
async function listLegacyArgs(env, userId, spec) {
    if (spec.args === 1) {
        const prefix = spec.v1(userId, SENTINEL).split(SENTINEL)[0];
        const ids = await listSuffixes(env, prefix);
        return ids.map(id => [id]);
    }

    if (spec.args === 2 && Array.isArray(spec.entityTypes)) {
        const tuples = [];
        for (const entityType of spec.entityTypes) {
            const prefix = spec.v1(userId, entityType, SENTINEL).split(SENTINEL)[0];
            for (const tag of await listSuffixes(env, prefix)) {
                tuples.push([entityType, tag]);
            }
        }
        return tuples;
    }

    return null;
}

/**
 * 整批回填，可中斷可重跑。
 *
 * 使用者清單來自 `access_tokens_*` 的 key —— 那是「有註冊過 bot 的人」的
 * 權威清單。進度存在 KV，所以每次呼叫處理一批，重跑從上次的位置繼續。
 *
 * @param {Object} env
 * @param {{batchSize?: number, force?: boolean, restart?: boolean}} [options]
 */
export async function migrateAll(env, options = {}) {
    const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    const force = options.force === true;
    const prefix = "access_tokens_";

    const cursor = options.restart ? null : await readText(env, BACKFILL_CURSOR_KEY);

    let page;
    try {
        page = await env.KV_LINE_STORAGE.list({ prefix, cursor: cursor || undefined, limit: batchSize });
    } catch (err) {
        return { success: false, error: `列出使用者失敗：${err.message}` };
    }

    const results = [];
    for (const key of page.keys || []) {
        const userId = key.name.slice(prefix.length);
        if (!userId) continue;
        const result = await migrateUser(env, userId, { force });
        results.push({
            userId,
            bots: result.bots,
            counts: result.counts,
            done: result.done,
            remaining: result.remaining,
        });
    }

    // 這一批裡只要有人沒回填完（會員數撞到單次預算），游標就不能前進 ——
    // 前進等於把那個人剩下的會員永久跳過，而且不會有任何錯誤。
    // 重做這一批沒有代價：已複製的部分是用列舉判斷的，0 次 KV 操作。
    const batchDone = results.every(r => r.done !== false);
    const remaining = results.reduce((sum, r) => sum + (r.remaining || 0), 0);

    // 游標在這一批真的做完之後才前進；中途失敗會丟出去，游標留在原處，
    // 重跑會重做這一批 —— 因為單一使用者是冪等的，重做沒有代價。
    const done = batchDone && page.list_complete === true;

    if (batchDone) {
        if (page.list_complete === true) {
            await env.KV_LINE_STORAGE.delete(BACKFILL_CURSOR_KEY);
        } else {
            await env.KV_LINE_STORAGE.put(BACKFILL_CURSOR_KEY, page.cursor);
        }
    }

    return {
        success: true,
        processed: results.length,
        done,
        remaining,
        nextCursor: done || !batchDone ? null : page.cursor,
        results,
    };
}

/**
 * 回填進度。
 */
export async function migrateStatus(env) {
    const cursor = await readText(env, BACKFILL_CURSOR_KEY);

    let total = 0;
    let listCursor;
    do {
        let page;
        try {
            page = await env.KV_LINE_STORAGE.list({ prefix: "access_tokens_", cursor: listCursor });
        } catch {
            break;
        }
        total += (page.keys || []).length;
        listCursor = page.list_complete ? undefined : page.cursor;
    } while (listCursor);

    const switched = Object.entries(RESOURCES).filter(([, s]) => s.switched).map(([n]) => n);
    const pending = Object.entries(RESOURCES).filter(([, s]) => !s.switched).map(([n]) => n);

    return {
        success: true,
        users: total,
        inProgress: cursor !== null,
        switchedResources: switched,
        pendingResources: pending,
    };
}

/**
 * 回滾單一使用者：刪掉回填建立的新 key。
 *
 * 舊 key 一筆都沒動過，所以回滾之後系統回到完全可用的狀態 —— 只是又變成
 * 只有舊命名空間有資料，而雙讀會自動走回退路徑。
 */
export async function rollbackUser(env, userId) {
    const logs = [];
    const log = (msg) => logs.push(msg);

    const userBots = await env.KV_LINE_STORAGE.get(UserKeys.bots(userId), { type: "json" });
    const fromList = userBots && Array.isArray(userBots.bots) ? userBots.bots.map(b => b.botId) : [];
    const fromTokens = (await listBotsOfUser(env, userId)).map(b => b.botId);
    const botIds = [...new Set([...fromList, ...fromTokens])];

    if (botIds.length === 0) {
        log(`⚠️ ${userId} 沒有可回滾的 bot。`);
        return { success: true, logs };
    }

    for (const botId of botIds) {
        // 刪掉這個 bot 命名空間下的全部 key，而不是一個一個列舉 ——
        // 列舉版本每次新增資源就會漏掉一個，而漏掉的那個沒有人會發現
        let cursor;
        let deleted = 0;
        do {
            const page = await env.KV_LINE_STORAGE.list({ prefix: BotKeys.prefix(botId), cursor });
            for (const key of page.keys || []) {
                await env.KV_LINE_STORAGE.delete(key.name);
                deleted += 1;
            }
            cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);

        log(`🗑️ bot ${botId}：刪除 ${deleted} 個 key`);
    }

    for (const spec of Object.values(USER_RESOURCES)) {
        await env.KV_LINE_STORAGE.delete(spec.next(userId));
    }
    await env.KV_LINE_STORAGE.delete(UserKeys.bots(userId));
    log("🗑️ user 命名空間已清除");

    log(`🎉 ${userId} 回滾完成（舊 key 未被動過）`);
    return { success: true, logs };
}

/**
 * API Handler
 *
 * GET /admin/migrate?key=<secret>&mode=<mode>
 *
 *   mode=user（預設）  &userId=U…      回填一個使用者
 *   mode=all                           回填一批，可重複呼叫直到 done=true
 *   mode=status                        看進度
 *   mode=rollback      &userId=U…      刪掉該使用者的新 key
 *
 *   &force=1   覆蓋已存在的新 key（危險：會蓋掉使用者在回填後做的修改）
 *   &restart=1 mode=all 時從頭開始，忽略既有游標
 */
export async function handleMigrate(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const migrationSecret = env.MIGRATION_SECRET;

    // Fail-closed：未設定 MIGRATION_SECRET 時拒絕執行，避免變成開放端點
    if (!migrationSecret) {
        console.error("[Migration] MIGRATION_SECRET 未設定，拒絕執行遷移端點");
        return jsonResponse({ error: "Migration endpoint not configured" }, 503);
    }

    if (!key || key !== migrationSecret) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const mode = url.searchParams.get("mode") || "user";
    const userId = url.searchParams.get("userId");
    const force = url.searchParams.get("force") === "1";
    const restart = url.searchParams.get("restart") === "1";
    const batchSize = Number(url.searchParams.get("batchSize")) || DEFAULT_BATCH_SIZE;

    try {
        if (mode === "status") {
            return jsonResponse(await migrateStatus(env));
        }

        if (mode === "all") {
            return jsonResponse(await migrateAll(env, { batchSize, force, restart }));
        }

        if (!userId) {
            return jsonResponse({ error: "Missing userId" }, 400);
        }

        if (mode === "rollback") {
            return jsonResponse(await rollbackUser(env, userId));
        }

        return jsonResponse(await migrateUser(env, userId, { force }));
    } catch (err) {
        // 僅在伺服器端記錄 stack，不回傳給用戶端
        console.error("[Migration] 遷移執行失敗:", err.stack || err);
        return jsonResponse({ error: err.message }, 500);
    }
}
