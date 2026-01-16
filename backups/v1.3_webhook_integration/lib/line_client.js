/**
 * LINE API Client 封裝
 */
import * as logger from '../utils/logger.js';

/**
 * 格式化回覆訊息 (將內部格式轉為 LINE 格式)
 */
export async function formatReplyMessage(reply, env, userId) {
    if (!reply || !reply.type) return null;

    switch (reply.type) {
        case 'text':
            return { type: 'text', text: reply.text };

        case 'flex':
            return {
                type: 'flex',
                altText: reply.altText || '您收到了一則 Flex 訊息',
                contents: reply.contents
            };

        case 'imagemap':
            // 🧩 支援 Imagemap 重導向 (某些開發環境需要)
            const baseUrl = reply.baseUrl || '';
            const finalBaseUrl = baseUrl.startsWith('http')
                ? "https://pinti-line-imagemap-url-redirect.hotichen.workers.dev/?uri=" + baseUrl.replace(/\.jpg$/, "")
                : baseUrl;

            return {
                type: 'imagemap',
                baseUrl: finalBaseUrl,
                altText: reply.altText || '您收到了一則圖卡訊息',
                baseSize: reply.baseSize,
                actions: reply.actions
            };

        default:
            logger.warn('LINE_CLIENT', `不支援的訊息類型: ${reply.type}`);
            return null;
    }
}

/**
 * 正規化 Imagemap Actions (LINE 要求 type 為 message 或 uri)
 */
export function normalizeImagemapActions(msg) {
    if (msg.type !== 'imagemap' || !msg.actions) return msg;

    const normalizedMsg = { ...msg };
    normalizedMsg.actions = msg.actions.map(action => {
        // 如果 type 是 keyword，轉為 message
        if (action.type === 'keyword') {
            return { ...action, type: 'message', text: action.text || action.keyword };
        }
        return action;
    });

    return normalizedMsg;
}

/**
 * 發送回覆 (具備重試機制)
 */
export async function replyWithRetry(replyToken, messages, accessToken, retryCount = 1) {
    const url = 'https://api.line.me/v2/bot/message/reply';

    for (let i = 0; i <= retryCount; i++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify({ replyToken, messages })
            });

            if (res.ok) {
                logger.info('LINE_API', '回覆發送成功');
                return true;
            }

            const err = await res.text();
            logger.error('LINE_API', `回覆發送失敗 (嘗試 ${i + 1}): ${res.status} ${err}`);

            if (i < retryCount) {
                await new Promise(r => setTimeout(r, 500)); // 等待 500ms 重試
            }
        } catch (err) {
            logger.error('LINE_API', `網路錯誤 (嘗試 ${i + 1})`, err);
            if (i < retryCount) {
                await new Promise(r => setTimeout(r, 500));
            }
        }
    }

    throw new Error('LINE API 回覆失敗且重試耗盡');
}
