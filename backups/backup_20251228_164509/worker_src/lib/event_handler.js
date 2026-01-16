/**
 * LINE Webhook 事件處理器
 * 處理各種 LINE 事件類型
 */
import * as logger from '../utils/logger.js';
import { findMatchingKeyword } from './keyword_matcher.js';
import { formatReplyMessage, normalizeImagemapActions, replyWithRetry } from './line_client.js';
/**
 * 取得 LINE 使用者 Profile
 */
async function getLineUserProfile(lineUserId, accessToken) {
    try {
        const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) {
            logger.warn('PROFILE', `取得使用者資料失敗: ${res.status}`);
            return null;
        }
        const profile = await res.json();
        logger.info('PROFILE', `使用者: ${profile.displayName}`);
        return profile;
    } catch (err) {
        logger.error('PROFILE', '取得使用者資料失敗', err);
        return null;
    }
}
/**
 * 替換訊息中的變數
 * 支援: (@name), (@date), (@time), (@day), (@year), (@month)
 */
function replaceMessageVariables(messages, variables) {
    const { userName } = variables;

    // 取得時間資訊 (台灣時間 UTC+8)
    const now = new Date();
    const twTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);

    const year = twTime.getUTCFullYear();
    const month = twTime.getUTCMonth() + 1;
    const date = twTime.getUTCDate();
    const hours = String(twTime.getUTCHours()).padStart(2, '0');
    const minutes = String(twTime.getUTCMinutes()).padStart(2, '0');

    const days = ['日', '一', '二', '三', '四', '五', '六'];
    const dayOfWeek = days[twTime.getUTCDay()];

    // 替換變數對照表
    const replacements = {
        '(@name)': userName,
        '(@date)': `${year}/${month}/${date}`,
        '(@time)': `${hours}:${minutes}`,
        '(@day)': `星期${dayOfWeek}`,
        '(@year)': String(year),
        '(@month)': String(month),
    };

    for (const msg of messages) {
        if (msg.type === 'text' && msg.text) {
            for (const [key, value] of Object.entries(replacements)) {
                msg.text = msg.text.replace(new RegExp(key.replace(/[()]/g, '\\$&'), 'gi'), value);
            }
        }
        if (msg.type === 'flex' && msg.altText) {
            for (const [key, value] of Object.entries(replacements)) {
                msg.altText = msg.altText.replace(new RegExp(key.replace(/[()]/g, '\\$&'), 'gi'), value);
            }
        }
    }

    return messages;
}
/**
 * 取得 Quick Reply 模板
 */
async function getQuickReplyTemplate(env, userId, qrId) {
    try {
        let qrList = [];
        let foundKey = '';
        const key1 = `quick_reply_list_${userId}`;
        qrList = await env.KV_STORAGE.get(key1, { type: 'json' }) || [];
        if (qrList.length > 0) {
            foundKey = key1;
        } else {
            const key2 = `bot:${userId}:quick_replies`;
            qrList = await env.KV_STORAGE.get(key2, { type: 'json' }) || [];
            if (qrList.length > 0) {
                foundKey = key2;
            } else {
                const key3 = `quick_replies_${userId}`;
                qrList = await env.KV_STORAGE.get(key3, { type: 'json' }) || [];
                if (qrList.length > 0) {
                    foundKey = key3;
                }
            }
        }
        logger.info('QR', `使用 Key: "${foundKey}", 共 ${qrList.length} 個模板`);
        const qr = qrList.find(q => q.id === qrId);
        if (!qr || !qr.items || qr.items.length === 0) {
            logger.debug('QR', `Quick Reply 模板 ${qrId} 不存在或無項目`);
            return null;
        }

        logger.info('QR', `取得 Quick Reply 模板: ${qr.name}, ${qr.items.length} 個按鈕`);
        return {
            items: qr.items.map(item => ({
                type: 'action',
                action: item.action
            }))
        };
    } catch (err) {
        logger.error('QR', '取得 Quick Reply 模板失敗', err);
        return null;
    }
}
/**
 * 處理 Message 事件
 */
export async function handleMessageEvent(event, env, userId, accessToken) {
    if (event.message.type !== 'text') {
        logger.info('MESSAGE', `收到非文字訊息: ${event.message.type}`);
        return;
    }
    const userMessage = event.message.text.trim();
    const lineUserId = event.source.userId;
    logger.info('MESSAGE', `使用者訊息: "${userMessage}"`);
    // 載入關鍵字列表
    const keywordList = await env.KV_STORAGE.get(`keyword_reply_list_${userId}`, { type: 'json' }) || [];
    // 匹配關鍵字
    const match = findMatchingKeyword(userMessage, keywordList);
    if (!match) {
        logger.debug('MATCH', '未找到匹配的關鍵字');
        return;
    }
    logger.info('MATCH', `匹配成功！關鍵字: "${match.keyword}", 回覆數: ${match.replies.length}`);
    // 格式化回覆訊息
    const messages = await Promise.all(
        match.replies.map(reply => formatReplyMessage(reply, env, userId))
    );
    // 過濾掉 null 值並正規化
    let validMessages = messages
        .filter(msg => msg !== null)
        .map(msg => normalizeImagemapActions(msg));
    if (validMessages.length === 0) {
        logger.warn('REPLY', '沒有有效的回覆訊息');
        return;
    }
    // 🆕 取得使用者名稱並替換變數
    const profile = await getLineUserProfile(lineUserId, accessToken);
    const userName = profile?.displayName || '用戶';
    validMessages = replaceMessageVariables(validMessages, { userName });
    // 處理 keyword-level 的 Quick Reply（附加到最後一則訊息）
    // 優先使用 keyword-level，向下相容 reply-level
    let qrId = match.quickReplyId;
    if (!qrId) {
        // 向下相容：檢查 replies 中是否有 quickReplyId
        const replyWithQR = match.replies.find(r => r.quickReplyId);
        if (replyWithQR) qrId = replyWithQR.quickReplyId;
    }
    if (qrId && validMessages.length > 0) {
        const quickReply = await getQuickReplyTemplate(env, userId, qrId);
        if (quickReply) {
            validMessages[validMessages.length - 1].quickReply = quickReply;
            logger.info('QR', `已附加 QR 到最後一則回覆`);
        }
    }
    // 發送回覆
    try {
        await replyWithRetry(event.replyToken, validMessages, accessToken);
        await incrementKeywordStat(env, userId, match.keyword);
    } catch (error) {
        logger.error('REPLY', '回覆訊息失敗', error);
        throw error;
    }
}
/**
 * 處理 Follow 事件
 */
export async function handleFollowEvent(event, env, userId, accessToken) {
    const lineUserId = event.source.userId;
    logger.info('FOLLOW', `新用戶加入: ${lineUserId}`);
    try {
        const welcomeConfig = await env.KV_STORAGE.get(`welcome_message_${userId}`, { type: 'json' });
        if (welcomeConfig && welcomeConfig.enabled && welcomeConfig.replies) {
            const messages = await Promise.all(
                welcomeConfig.replies.map(reply => formatReplyMessage(reply, env, userId))
            );
            let validMessages = messages.filter(msg => msg !== null);
            // 🆕 取得使用者名稱並替換變數
            const profile = await getLineUserProfile(lineUserId, accessToken);
            const userName = profile?.displayName || '用戶';
            validMessages = replaceMessageVariables(validMessages, { userName });
            // 處理 keyword-level 的 Quick Reply
            let qrId = welcomeConfig.quickReplyId;
            if (!qrId) {
                const replyWithQR = welcomeConfig.replies.find(r => r.quickReplyId);
                if (replyWithQR) qrId = replyWithQR.quickReplyId;
            }
            if (qrId && validMessages.length > 0) {
                const quickReply = await getQuickReplyTemplate(env, userId, qrId);
                if (quickReply) {
                    validMessages[validMessages.length - 1].quickReply = quickReply;
                    logger.info('QR', `已附加 QR 到歡迎訊息`);
                }
            }
            if (validMessages.length > 0) {
                await replyWithRetry(event.replyToken, validMessages, accessToken);
                logger.info('FOLLOW', '已發送歡迎訊息');
            }
        }
    } catch (error) {
        logger.error('FOLLOW', '處理 Follow 事件失敗', error);
    }
}
/**
 * 處理 Unfollow 事件
 */
export async function handleUnfollowEvent(event, env, userId) {
    const lineUserId = event.source.userId;
    logger.info('UNFOLLOW', `用戶封鎖: ${lineUserId}`);
}
/**
 * 處理 Postback 事件
 */
export async function handlePostbackEvent(event, env, userId, accessToken) {
    const postbackData = event.postback.data;
    logger.info('POSTBACK', `收到 Postback: ${postbackData}`);
    try {
        const message = {
            type: 'text',
            text: `✅ 已收到您的操作：${postbackData}`
        };
        await replyWithRetry(event.replyToken, [message], accessToken);
    } catch (error) {
        logger.error('POSTBACK', '處理 Postback 失敗', error);
    }
}
/**
 * 增加關鍵字統計
 */
async function incrementKeywordStat(env, userId, keyword) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const statsKey = `keyword_stats_${userId}`;
    const stats = await env.KV_STORAGE.get(statsKey, { type: 'json' }) || {};
    if (!stats[keyword]) {
        stats[keyword] = { total: 0, monthly: {} };
    }
    stats[keyword].total = (stats[keyword].total || 0) + 1;
    stats[keyword].monthly[currentMonth] = (stats[keyword].monthly[currentMonth] || 0) + 1;
    await env.KV_STORAGE.put(statsKey, JSON.stringify(stats));
    logger.debug('STATS', `關鍵字 "${keyword}" 統計 +1`);
}
