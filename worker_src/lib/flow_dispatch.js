// worker_src/lib/flow_dispatch.js
// 把已發布的 flow 接到 webhook：event_handler 只需要問「這個事件 flow 有沒有處理」。
//
// 規則：
//   - 文字訊息命中已發布 flow 的關鍵字 → flow 回覆（優先於「關鍵字回覆」頁的設定）；
//     命中但流程沒有東西可回 → 交回關鍵字回覆
//   - flow: 開頭的 postback → 依按鈕連線繼續；找不到對應就安靜略過（不可回「已收到 flow:...」）
//   - 延遲節點：之後的內容排進 KV，由 cron 每分鐘檢查到期的工作，用 push 送出
//   - 讀不到 / 壞資料 → 當作沒有發布，交回原本的處理（fail-open：flow 壞掉不能讓 bot 整個不回）
//
// LINE userId 只用來送訊息與排程，不寫進 log。

import * as logger from '../utils/logger.js';
import { BotKeys, FlowJobKeys } from './kv_schema.js';
import { formatReplyMessage, normalizeImagemapActions, replyWithRetry } from './line_client.js';
import { pushMessage } from './line_api.js';
import { incrementMessageCount } from './message_stats.js';
import { getAccessTokenForDestination } from './token_store.js';
import { openBotStoreFor } from './bot_store.js';
import { replaceMessageVariables, loadVariableContext } from './message_variables.js';
import { getQuickReplyTemplate } from './quick_reply.js';
import { callApi, flattenApiResult, MAX_API_CALLS } from './flow_api.js';
import { findTrigger, runFrom, runTrigger, runButton, parseFlowPostback, MAX_DELAY_SECONDS } from './flow_runtime.js';

const MAX_JOBS_PER_RUN = 50;

export async function loadPublishedFlow(env, botId) {
    if (!env || !env.KV_LINE_STORAGE || !botId) return null;
    try {
        const published = await env.KV_LINE_STORAGE.get(BotKeys.flowPublished(botId), { type: 'json' });
        return published && published.version === 1 && published.nodes && published.edges && Array.isArray(published.triggers)
            ? published
            : null;
    } catch (err) {
        logger.error('FLOW', `讀取已發布流程失敗: ${err.message}`);
        return null;
    }
}

async function loadMemberTags(store, lineUserId) {
    try {
        const profile = await store.getOr('member', {}, lineUserId);
        return Array.isArray(profile && profile.tags) ? profile.tags : [];
    } catch {
        return [];
    }
}

/** 標籤動作：與 postback 標籤一致，只更新已存在的會員 */
async function applyTags(store, lineUserId, tags) {
    if (!lineUserId || (!tags.add.length && !tags.remove.length)) return;
    const profile = await store.getOr('member', {}, lineUserId);
    if (!profile || Object.keys(profile).length === 0) return;
    const current = new Set(Array.isArray(profile.tags) ? profile.tags : []);
    tags.add.forEach((t) => current.add(t));
    tags.remove.forEach((t) => current.delete(t));
    profile.tags = [...current];
    await store.put('member', profile, lineUserId);
}

/** 延遲：把「延遲之後」要執行的節點排進 KV（cron 會取走） */
async function scheduleDeferred(deferred, { env, userId, botId, published, lineUserId }) {
    if (!deferred.length || !lineUserId) return;
    const now = Date.now();
    for (const d of deferred) {
        const seconds = Math.min(Math.max(d.seconds, 1), MAX_DELAY_SECONDS);
        // 同一個使用者在同一個延遲節點等待期間不重複排程：否則狂傳關鍵字就能耗光官方帳號的推播額度
        const gate = FlowJobKeys.gate(botId, lineUserId, published.flowId, d.startIds);
        if (await env.KV_LINE_STORAGE.get(gate)) continue;
        await env.KV_LINE_STORAGE.put(gate, '1', { expirationTtl: seconds + 60 });

        const id = `${Math.random().toString(36).slice(2, 10)}`;
        const job = { botId, userId, flowId: published.flowId, startIds: d.startIds, lineUserId, createdAt: now };
        await env.KV_LINE_STORAGE.put(FlowJobKeys.key(now + seconds * 1000, id), JSON.stringify(job), {
            expirationTtl: seconds + 24 * 60 * 60, // 到期後保留一天讓 cron 追得上；之後自動清掉
        });
    }
}

/**
 * 送出執行結果：API → 變數 / Quick Reply → 回覆或推播 → 標籤 → 排程延遲
 * @param {object} result runFrom 的結果
 * @param {object} c { env, userId, botId, accessToken, store, published, lineUserId, replyToken|null }
 *   有 replyToken 用回覆（免費）；沒有就用推播（計入每月額度）
 */
async function deliver(result, c) {
    const { env, userId, botId, accessToken, store, published, lineUserId, replyToken } = c;

    // 1. API 節點：先執行，結果變成 (@api.xxx) 變數
    let extra = {};
    for (const call of result.apiCalls.slice(0, MAX_API_CALLS)) {
        extra = { ...extra, ...flattenApiResult(await callApi(call.data)) };
    }

    // 2. 格式化訊息、替換變數、Quick Reply
    const formatted = await Promise.all(result.messages.map((m) => formatReplyMessage(m, env, userId)));
    const messages = formatted.filter(Boolean).map(normalizeImagemapActions);

    if (messages.length) {
        const usesVariables = messages.some((m) => /\(@/.test(`${m.text || ''}${m.altText || ''}`));
        if (usesVariables || Object.keys(extra).length) {
            const base = usesVariables ? await loadVariableContext(store, lineUserId, accessToken) : {};
            replaceMessageVariables(messages, { ...base, extra });
        }
        if (result.quickReplyId) {
            const quickReply = await getQuickReplyTemplate(store, result.quickReplyId);
            if (quickReply) messages[messages.length - 1].quickReply = quickReply;
        }

        if (replyToken) await replyWithRetry(replyToken, messages, accessToken);
        else await pushMessage(accessToken, lineUserId, messages);
        await incrementMessageCount(store, replyToken ? 'reply' : 'push');
    }

    // 3. 標籤、延遲排程：回覆已經送出，這兩步失敗只記錄，不重送
    try {
        await applyTags(store, lineUserId, result.tags);
        await scheduleDeferred(result.deferred, { env, userId, botId, published, lineUserId });
    } catch (err) {
        logger.error('FLOW', `標籤或延遲排程失敗: ${err.message}`);
    }
}

function context(c) {
    return { env: c.env, userId: c.userId, botId: c.botId, accessToken: c.accessToken, store: c.store };
}

/** @returns {Promise<boolean>} true = flow 已處理（呼叫端不要再跑關鍵字回覆） */
export async function tryHandleFlowMessage(c) {
    const { event, env, botId } = c;
    const published = await loadPublishedFlow(env, botId);
    if (!published) return false;

    const text = event.message && event.message.text;
    const trigger = findTrigger(published, text);
    if (!trigger) return false;

    const lineUserId = event.source && event.source.userId;
    const result = runTrigger(published, trigger, {
        text, userId: lineUserId, tags: await loadMemberTags(c.store, lineUserId),
    });
    // 命中但流程沒有任何東西可回（例如從 Richmenu 按鈕展開、還沒接回覆的關鍵字節點）：
    // 交回「關鍵字回覆」，不能攔下訊息卻什麼都不回
    const nothing = !result.messages.length && !result.tags.add.length && !result.tags.remove.length
        && !result.deferred.length && !result.apiCalls.length;
    if (nothing) return false;

    logger.info('FLOW', `命中已發布流程「${published.name}」的關鍵字「${trigger.keyword}」`);
    await deliver(result, { ...context(c), published, lineUserId, replyToken: event.replyToken });
    return true;
}

/** @returns {Promise<boolean>} true = 這是 flow 的 postback（已處理或已略過） */
export async function tryHandleFlowPostback(c) {
    const { event, env, botId } = c;
    const parsed = parseFlowPostback(event.postback && event.postback.data);
    if (!parsed) return false;

    const published = await loadPublishedFlow(env, botId);
    const lineUserId = event.source && event.source.userId;
    // 按鈕沒有「使用者剛說的話」，text 條件一律用空字串
    const result = published
        ? runButton(published, parsed, { text: '', userId: lineUserId, tags: await loadMemberTags(c.store, lineUserId) })
        : null;
    if (!result) {
        logger.warn('FLOW', '收到的 flow 按鈕已失效（流程已取消發布或被修改），略過');
        return true;
    }
    await deliver(result, { ...context(c), published, lineUserId, replyToken: event.replyToken });
    return true;
}

/**
 * cron 每分鐘呼叫：執行到期的延遲工作（以 push 送出）
 * 先刪再執行（at-most-once）：寧可少送一次，也不要重複推播給使用者。
 * @returns {Promise<{processed: number, skipped: number}>}
 */
export async function runDueFlowJobs(env, now = Date.now()) {
    const stats = { processed: 0, skipped: 0 };
    if (!env || !env.KV_LINE_STORAGE) return stats;

    const { keys } = await env.KV_LINE_STORAGE.list({ prefix: FlowJobKeys.prefix, limit: MAX_JOBS_PER_RUN });
    for (const { name } of keys) {
        const runAt = FlowJobKeys.parseRunAt(name);
        if (runAt === null || runAt > now) break; // key 依時間排序，後面都還沒到

        let job;
        try {
            const raw = await env.KV_LINE_STORAGE.get(name);
            await env.KV_LINE_STORAGE.delete(name);
            job = raw ? JSON.parse(raw) : null;
        } catch {
            job = null;
        }
        if (!job || !job.botId || !job.userId || !job.lineUserId || !Array.isArray(job.startIds)) { stats.skipped++; continue; }

        try {
            const published = await loadPublishedFlow(env, job.botId);
            // 流程已取消發布或換成別份：舊的延遲工作不再執行
            if (!published || published.flowId !== job.flowId) { stats.skipped++; continue; }

            const { token: accessToken } = await getAccessTokenForDestination(env, job.userId, job.botId);
            if (!accessToken) { stats.skipped++; continue; }

            const store = openBotStoreFor(env, job.userId, job.botId);
            const result = runFrom(published, job.startIds, {
                text: '', userId: job.lineUserId, tags: await loadMemberTags(store, job.lineUserId),
            });
            await deliver(result, {
                env, userId: job.userId, botId: job.botId, accessToken, store, published,
                lineUserId: job.lineUserId, replyToken: null,
            });
            stats.processed++;
        } catch (err) {
            logger.error('FLOW', `延遲工作執行失敗: ${err.message}`);
            stats.skipped++;
        }
    }
    return stats;
}
