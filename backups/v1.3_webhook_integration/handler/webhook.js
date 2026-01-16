/**
 * LINE Webhook 處理程序
 */
import { verifySignature } from '../lib/signature.js';
import * as EventHandler from '../lib/event_handler.js';
import * as logger from '../utils/logger.js';

export async function handleWebhookRequest(request, env) {
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
        const destinationKey = `destination_user_${destination}`;
        const userId = await env.KV_LINE_STORAGE.get(destinationKey); // 使用專案統一的 KV 變數名

        if (!userId) {
            logger.error('ROUTING', `找不到 destination ${destination} 對應的 userId`);
            return new Response('OK', { status: 200 }); // 仍回傳 200 給 LINE
        }

        // 3. 取得當前專案的 Access Token
        const tokenMap = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: 'json' }) || {};
        const currentProject = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
        const currentData = tokenMap[currentProject];
        const accessToken = typeof currentData === 'string' ? currentData : currentData?.token;

        if (!accessToken) {
            logger.error('AUTH', `找不到 userId ${userId} 的 Access Token`);
            return new Response('OK', { status: 200 });
        }

        // 4. 處理所有事件
        const events = body.events || [];
        for (const event of events) {
            try {
                switch (event.type) {
                    case 'message':
                        await EventHandler.handleMessageEvent(event, env, userId, accessToken);
                        break;
                    case 'follow':
                        await EventHandler.handleFollowEvent(event, env, userId, accessToken);
                        break;
                    case 'unfollow':
                        await EventHandler.handleUnfollowEvent(event, env, userId);
                        break;
                    case 'postback':
                        await EventHandler.handlePostbackEvent(event, env, userId, accessToken);
                        break;
                    default:
                        logger.debug('EVENT', `不處理的事件類型: ${event.type}`);
                }
            } catch (err) {
                logger.error('EVENT', `處理事件 ${event.type} 失敗`, err);
            }
        }

        const duration = Date.now() - startTime;
        logger.info('PERFORMANCE', `處理完成，耗時: ${duration}ms`);
        return new Response('OK', { status: 200 });

    } catch (error) {
        logger.error('GLOBAL', 'Webhook 處理發生發生異常', error);
        return new Response('OK', { status: 200 });
    }
}

export function route(request, env, userId, pathname) {
    if (pathname === "/api/webhook" && request.method === "POST") {
        return handleWebhookRequest(request, env);
    }
    return null;
}
