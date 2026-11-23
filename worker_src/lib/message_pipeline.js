// worker_src/lib/message_pipeline.js
// 回覆訊息的共用管線：關鍵字回覆、歡迎訊息、流程都走這幾個函式，不再各寫一份。
//
//   formatReplies   回覆物件 → LINE 訊息（丟掉不合法的、限制 5 則、Imagemap 正規化）
//   finalizeMessages 變數替換 + 套 Quick Reply
//   sendMessages    有 replyToken 用回覆（免費），否則用推播（計入每月額度）
//
// 型別規則（驗證 / 轉換）在 js/shared/message_core.js。

import * as logger from '../utils/logger.js';
import { LINE_MAX_MESSAGES, normalizeImagemapActions } from '../../js/shared/message_core.js';
import { formatReplyMessage, replyWithRetry } from './line_client.js';
import { pushMessage } from './line_api.js';
import { replaceMessageVariables } from './message_variables.js';
import { getQuickReplyTemplate } from './quick_reply.js';

/**
 * 回覆物件陣列 → 可直接送給 LINE 的訊息陣列
 * 不合法的訊息會被丟掉（一則壞訊息不能讓整次回覆被 LINE 拒絕）；超過 5 則的截斷。
 */
export async function formatReplies(replies, env, userId) {
    const formatted = await Promise.all((replies || []).map((reply) => formatReplyMessage(reply, env, userId)));
    const messages = formatted.filter(Boolean).map(normalizeImagemapActions);
    if (messages.length > LINE_MAX_MESSAGES) {
        logger.warn('MESSAGE', `回覆有 ${messages.length} 則，超過 LINE 上限 ${LINE_MAX_MESSAGES}，多的已截斷`);
        return messages.slice(0, LINE_MAX_MESSAGES);
    }
    return messages;
}

/** 把 Quick Reply 模板套在最後一則；模板不存在就略過。回傳是否有套上 */
export async function attachQuickReply(store, messages, quickReplyId) {
    if (!quickReplyId || !messages.length) return false;
    const quickReply = await getQuickReplyTemplate(store, quickReplyId);
    if (!quickReply) return false;
    messages[messages.length - 1].quickReply = quickReply;
    return true;
}

/**
 * 變數替換 + Quick Reply（就地修改並回傳 messages）
 * @param {{variables?: object|null, store?: object, quickReplyId?: string|null}} options
 *   variables 是 replaceMessageVariables 的參數（userName / tierInfo / extra）；null 表示不替換
 */
export async function finalizeMessages(messages, { variables = null, store = null, quickReplyId = null } = {}) {
    if (variables) replaceMessageVariables(messages, variables);
    if (store) await attachQuickReply(store, messages, quickReplyId);
    return messages;
}

/**
 * 送出：有 replyToken → 回覆（免費、可重試）；否則推播（計入每月訊息額度）
 * @returns {'reply'|'push'|null} 實際使用的方式；沒有訊息時回 null
 */
export async function sendMessages(messages, { replyToken = null, to = null, accessToken }) {
    if (!messages.length) return null;
    if (replyToken) {
        await replyWithRetry(replyToken, messages, accessToken);
        return 'reply';
    }
    await pushMessage(accessToken, to, messages);
    return 'push';
}
