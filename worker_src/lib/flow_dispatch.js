// worker_src/lib/flow_dispatch.js
// 把已發布的 flow 接到 webhook：event_handler 只需要問「這個事件 flow 有沒有處理」。
//
// 規則：
//   - 文字訊息命中已發布 flow 的關鍵字 → flow 回覆（優先於「關鍵字回覆」頁的設定）
//   - flow: 開頭的 postback → 依按鈕連線繼續；找不到對應就安靜略過（不可回「已收到 flow:...」）
//   - 讀不到 / 壞資料 → 當作沒有發布，交回原本的處理（fail-open：flow 壞掉不能讓 bot 整個不回）

import * as logger from '../utils/logger.js';
import { BotKeys } from './kv_schema.js';
import { formatReplyMessage, normalizeImagemapActions, replyWithRetry } from './line_client.js';
import { incrementMessageCount } from './message_stats.js';
import { findTrigger, runTrigger, runButton, parseFlowPostback } from './flow_runtime.js';

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

async function deliver(result, { event, env, userId, accessToken, store }) {
    const formatted = await Promise.all(result.messages.map((m) => formatReplyMessage(m, env, userId)));
    const messages = formatted.filter(Boolean).map(normalizeImagemapActions);

    if (messages.length) {
        await replyWithRetry(event.replyToken, messages, accessToken);
        await incrementMessageCount(store, 'reply');
    }
    try {
        await applyTags(store, event.source && event.source.userId, result.tags);
    } catch (err) {
        logger.error('FLOW', `標籤更新失敗: ${err.message}`); // 回覆已送出，標籤失敗不重送
    }
}

/** @returns {Promise<boolean>} true = flow 已處理（呼叫端不要再跑關鍵字回覆） */
export async function tryHandleFlowMessage(ctx) {
    const { event, env, botId } = ctx;
    const published = await loadPublishedFlow(env, botId);
    if (!published) return false;

    const trigger = findTrigger(published, event.message && event.message.text);
    if (!trigger) return false;

    logger.info('FLOW', `命中已發布流程「${published.name}」的關鍵字「${trigger.keyword}」`);
    await deliver(runTrigger(published, trigger), ctx);
    return true;
}

/** @returns {Promise<boolean>} true = 這是 flow 的 postback（已處理或已略過） */
export async function tryHandleFlowPostback(ctx) {
    const { event, env, botId } = ctx;
    const parsed = parseFlowPostback(event.postback && event.postback.data);
    if (!parsed) return false;

    const published = await loadPublishedFlow(env, botId);
    const result = published ? runButton(published, parsed) : null;
    if (!result) {
        logger.warn('FLOW', '收到的 flow 按鈕已失效（流程已取消發布或被修改），略過');
        return true;
    }
    await deliver(result, ctx);
    return true;
}
