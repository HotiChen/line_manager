/**
 * LINE Webhook 處理程序
 */
import { verifySignature } from '../lib/signature.js';
import * as EventHandler from '../lib/event_handler.js';
import * as logger from '../utils/logger.js';

export async function handleWebhookRequest(request, env, ctx) {
    const startTime = Date.now();
    try {
        if (request.method !== 'POST') {
            logger.warn('WEBHOOK', '收到非 POST 請求');
            return new Response('Method Not Allowed', { status: 405 });
        }

        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        logger.info('WEBHOOK', '收到 LINE Webhook 請求', { destination: body.destination });

        // 1. 簽章驗證 (可選，建議開啟)
        const channelSecret = env.LINE_CHANNEL_SECRET; // 確保 wrangler.toml 有此變數
        if (channelSecret) {
            const isValid = await verifySignature(request, bodyText, channelSecret);
            if (!isValid) {
                logger.error('SECURITY', '簽章驗證失敗');
                return new Response('Unauthorized', { status: 401 });
            }
            logger.info('SECURITY', '簽章驗證通過');
        } else {
            logger.warn('CONFIG', '缺少 LINE_CHANNEL_SECRET，跳過簽章驗證');
        }

        // 2. 取得 destination 對應的 userId
        const destination = body.destination;
        if (!destination) {
            logger.warn('WEBHOOK', 'Webhook body 中缺少 destination');
            return new Response('OK', { status: 200 });
        }

        const destinationKey = `destination_user_${destination}`;
        let userId = await env.KV_LINE_STORAGE.get(destinationKey);

        // 如果找不到 mapping，嘗試從全局會員列表或現有 token map 中尋找 (容錯機制)
        if (!userId) {
            logger.warn('ROUTING', `直接映射找不到 destination ${destination}，嘗試次要搜尋...`);
            // 此處暫不實現複雜掃描，但記錄警告以利調試
            logger.error('ROUTING', `關鍵路由缺失: ${destinationKey}`);
            return new Response('OK', { status: 200 });
        }

        logger.debug('ROUTING', `解析成功: destination=${destination} -> userId=${userId}`);

        // 3. 取得對應該 destination 的 Access Token
        const tokenMap = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: 'json' }) || {};

        // 尋找哪一個專案的 destination 符合目前的 webhook
        let accessToken = null;
        let projectName = null;

        for (const [pName, pData] of Object.entries(tokenMap)) {
            const pDestination = typeof pData === 'string' ? null : pData.destination;
            if (pDestination === destination) {
                accessToken = typeof pData === 'string' ? pData : pData.token;
                projectName = pName;
                break;
            }
        }

        // 容錯：如果找不到精確匹配，嘗試用當前選中的 (向下相容)
        if (!accessToken) {
            logger.warn('AUTH', `找不到 destination ${destination} 的精確匹配，使用當前選中專案...`);
            const currentProject = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
            if (currentProject && tokenMap[currentProject]) {
                const currentData = tokenMap[currentProject];
                accessToken = typeof currentData === 'string' ? currentData : currentData?.token;
                projectName = currentProject;
            }
        }

        if (!accessToken) {
            logger.error('AUTH', `完全找不到 userId ${userId} 對應 destination ${destination} 的 Access Token`, {
                availableDestinations: Object.values(tokenMap).map(d => d.destination)
            });
            return new Response('OK', { status: 200 });
        }

        logger.info('AUTH', `路由成功: 使用專案 "${projectName}" 處理請求`);

        // 4. 處理所有事件 (移至背景執行以加速回應)
        const events = body.events || [];
        if (ctx && ctx.waitUntil) {
            ctx.waitUntil((async () => {
                for (const event of events) {
                    try {
                        logger.info('EVENT', `開始處理背景事件: ${event.type}`, { replyToken: event.replyToken });
                        switch (event.type) {
                            case 'message':
                                await EventHandler.handleMessageEvent(event, env, userId, accessToken, ctx);
                                break;
                            case 'follow':
                                await EventHandler.handleFollowEvent(event, env, userId, accessToken, ctx);
                                break;
                            case 'unfollow':
                                await EventHandler.handleUnfollowEvent(event, env, userId);
                                break;
                            case 'postback':
                                await EventHandler.handlePostbackEvent(event, env, userId, accessToken, ctx);
                                break;
                            default:
                                logger.debug('EVENT', `不處理的事件類型: ${event.type}`);
                        }
                    } catch (err) {
                        logger.error('EVENT', `處理事件 ${event.type} 失敗`, err);
                    }
                }
                const duration = Date.now() - startTime;
                logger.info('PERFORMANCE', `背景處理完成，總耗時: ${duration}ms`);
            })());
        } else {
            logger.warn('SYSTEM', '環境不支援 waitUntil，改為同步處理 Webhook');
            for (const event of events) {
                try {
                    if (event.type === 'message') await EventHandler.handleMessageEvent(event, env, userId, accessToken, ctx);
                    else if (event.type === 'follow') await EventHandler.handleFollowEvent(event, env, userId, accessToken, ctx);
                    else if (event.type === 'unfollow') await EventHandler.handleUnfollowEvent(event, env, userId);
                    else if (event.type === 'postback') await EventHandler.handlePostbackEvent(event, env, userId, accessToken, ctx);
                } catch (err) { logger.error('EVENT', '同步處理失敗', err); }
            }
        }

        return new Response('OK', { status: 200 });

    } catch (error) {
        logger.error('GLOBAL', 'Webhook 處理異常', error);
        return new Response('OK', { status: 200 });
    }
}

export function route(request, env, userId, pathname, ctx) {
    if (pathname === "/api/webhook" && request.method === "POST") {
        return handleWebhookRequest(request, env, ctx);
    }
    return null;
}
