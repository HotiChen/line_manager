/**
 * LINE API Client 封裝
 */
import * as logger from '../utils/logger.js';

/**
 * 取得 LINE 使用者 Profile
 * 
 * Pre-conditions:
 * - lineUserId 與 accessToken 不可為空
 * Post-conditions:
 * - 成功回傳 profile 物件，失敗或無效參數回傳 null
 */
export async function getLineUserProfile(lineUserId, accessToken) {
    if (!lineUserId || !accessToken) {
        logger.warn('PROFILE', '缺少 lineUserId 或 accessToken，提早放棄請求');
        return null;
    }

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
 * 格式化回覆訊息 (將內部格式轉為 LINE 格式)
 * 
 * Pre-conditions:
 * - reply 必須包含 type 屬性
 * Post-conditions:
 * - 回傳符合 Messaging API 的格式，不支援類型回傳 null
 */
export async function formatReplyMessage(reply, env, userId) {
    if (!reply || typeof reply !== 'object' || !reply.type) {
        logger.warn('LINE_CLIENT', '無效的 reply 物件或缺少 type，格式化終止');
        return null;
    }

    switch (reply.type) {
        case 'text':
            return { type: 'text', text: reply.text };

        case 'flex':
            let contents = reply.contents;
            // 如果只有 id，嘗試從 KV 抓取
            if (!contents && reply.id) {
                const flexList = await env.KV_LINE_STORAGE.get(`bot:${userId}:flex_list`, { type: 'json' }) || [];
                const found = flexList.find(f => f.id === reply.id);
                if (found) contents = found.contents;
            }
            if (!contents) {
                logger.warn('LINE_CLIENT', `Flex 訊息內容缺失: ${reply.id || '未知 ID'}`);
                return null;
            }
            return {
                type: 'flex',
                altText: reply.altText || '您收到了一則 Flex 訊息',
                contents: contents
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
 * 
 * Pre-conditions:
 * - 無特別限制
 */
export function normalizeImagemapActions(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'imagemap' || !Array.isArray(msg.actions)) {
        return msg;
    }

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
 * 
 * Pre-conditions:
 * - replyToken, messages, accessToken 皆不可為空
 */
export async function replyWithRetry(replyToken, messages, accessToken, retryCount = 1) {
    if (!replyToken || !messages || !accessToken) {
        logger.error('LINE_API', '缺少發送回覆的必要參數 (replyToken / messages / accessToken)');
        throw new Error('LINE API 發送回覆缺少必要參數');
    }

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

/**
 * 將 Rich Menu 綁定給特定使用者
 * @param {string} lineUserId LINE 使用者 ID
 * @param {string} richMenuId Rich Menu ID
 * @param {string} accessToken LINE Access Token
 * 
 * Pre-conditions:
 * - lineUserId, richMenuId, accessToken 皆不可為空
 */
export async function linkRichMenuToUser(lineUserId, richMenuId, accessToken) {
    if (!lineUserId || !richMenuId || !accessToken) {
        logger.warn('LINE_API', '綁定選單缺少必要參數，提早中斷');
        return false;
    }

    const url = `https://api.line.me/v2/bot/user/${lineUserId}/richmenu/${richMenuId}`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (res.ok) {
            logger.info('LINE_API', `Rich Menu 連結成功: ${lineUserId} -> ${richMenuId}`);
            return true;
        }

        const err = await res.text();
        logger.error('LINE_API', `Rich Menu 連結失敗: ${res.status} ${err}`);
        return false;
    } catch (err) {
        logger.error('LINE_API', 'Rich Menu 連結發生網路錯誤', err);
        return false;
    }
}

/**
 * 取消使用者的特定 Rich Menu 綁定
 * @param {string} lineUserId LINE 使用者 ID
 * @param {string} accessToken LINE Access Token
 * 
 * Pre-conditions:
 * - lineUserId 與 accessToken 不可為空
 */
export async function unlinkRichMenuFromUser(lineUserId, accessToken) {
    if (!lineUserId || !accessToken) {
        logger.warn('LINE_API', '解除綁定選單缺少必要參數，提早中斷');
        return false;
    }

    const url = `https://api.line.me/v2/bot/user/${lineUserId}/richmenu`;
    try {
        const res = await fetch(url, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (res.ok) {
            logger.info('LINE_API', `Rich Menu 取消連結成功: ${lineUserId}`);
            return true;
        }

        const err = await res.text();
        logger.error('LINE_API', `Rich Menu 取消連結失敗: ${res.status} ${err}`);
        return false;
    } catch (err) {
        logger.error('LINE_API', 'Rich Menu 取消連結發生網路錯誤', err);
        return false;
    }
}
