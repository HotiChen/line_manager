/**
 * LINE Webhook 處理程序
 * 負責接收並解析 LINE Webhook 事件，路由至正確的用戶與專案邏輯。
 */
import { verifySignature } from '../lib/signature.js';
import { getChannelSecret } from '../lib/channel_secret.js';
import * as EventHandler from '../lib/event_handler.js';
import { getAccessTokenForDestination, getCurrentAccessToken } from '../lib/token_store.js';
import * as logger from '../utils/logger.js';

/**
 * handleWebhookRequest
 * 處理 LINE Webhook 進入點
 * 
 * Pre-conditions:
 * - request: 來自 LINE 的 POST 請求，包含事件陣列
 * - env: Cloudflare Worker 綁定的變數與 KV 儲存
 * - ctx: Worker ExecutionContext (支援 waitUntil)
 * 
 * Post-conditions:
 * - 回傳 200 OK 給 LINE (不論後續處理成功與否，避免 LINE 重複發送)
 * - 依據事件類型非同步分發至 EventHandler
 */
export async function handleWebhookRequest(request, env, ctx) {
    if (!request || !env) {
        logger.error('WEBHOOK', '缺少 request 或 env 物件，放棄處理');
        return new Response('Bad Request', { status: 400 });
    }

    const startTime = Date.now();
    try {
        if (request.method !== 'POST') {
            logger.warn('WEBHOOK', '收到非 POST 請求');
            return new Response('Method Not Allowed', { status: 405 });
        }

        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        logger.info('WEBHOOK', '收到 LINE Webhook 請求', { destination: body.destination });

        // 1. 簽章驗證
        //
        // 每個 LINE channel 的 secret 都不同，所以先用 body 的 destination 挑出「這個 bot 自己的」
        // secret。destination 在驗證前不可信 —— 它只決定「用哪把密鑰」，通不通過仍然由 HMAC 決定：
        // 攻擊者填別人的 destination，只會換來對方的密鑰，簽不出對的簽章。
        //
        //   - 這個 bot 登記過自己的 secret → 只用它驗。不可退回全域密鑰，否則持有全域密鑰的人
        //     可以偽造別的 bot 的事件。
        //   - 沒登記 → 退回全域 LINE_CHANNEL_SECRET（既有官方帳號不中斷），並記警告。
        //     全部登記完之後設 WEBHOOK_GLOBAL_SECRET_DISABLED=1 就不再退回。
        //   - 兩者都沒有 → 設定錯誤，500（不是放行）。
        const rawDestination = typeof body.destination === 'string' ? body.destination : null;
        const botSecret = rawDestination ? await getChannelSecret(env, rawDestination) : null;

        let channelSecret = botSecret;
        if (!channelSecret) {
            if (env.WEBHOOK_GLOBAL_SECRET_DISABLED === '1') {
                logger.error('SECURITY', '此官方帳號未登記 channel secret，且已停用全域密鑰');
                return new Response('Unauthorized', { status: 401 });
            }
            channelSecret = env.LINE_CHANNEL_SECRET;
            if (!channelSecret) {
                logger.error('CONFIG', '未設定 LINE_CHANNEL_SECRET，且此官方帳號未登記 channel secret，拒絕 webhook 請求');
                return new Response('Service Misconfigured', { status: 500 });
            }
            logger.warn('SECURITY', '使用全域 LINE_CHANNEL_SECRET 驗簽（此官方帳號尚未登記自己的 channel secret）');
        }

        const isValid = await verifySignature(request, bodyText, channelSecret);
        if (!isValid) {
            logger.error('SECURITY', '簽章驗證失敗');
            return new Response('Unauthorized', { status: 401 });
        }
        logger.info('SECURITY', '簽章驗證通過');

        // 2. 路由判斷：取得 destination 對應的 userId
        const destination = body.destination;
        if (!destination) {
            logger.warn('WEBHOOK', 'Webhook body 中缺少 destination');
            return new Response('OK', { status: 200 });
        }

        const userId = await env.KV_LINE_STORAGE.get(`destination_user_${destination}`);
        if (!userId) {
            logger.error('ROUTING', `關鍵路由缺失: destination_user_${destination}`);
            return new Response('OK', { status: 200 });
        }

        logger.debug('ROUTING', `解析成功: destination=${destination} -> userId=${userId}`);

        // 3. 取得對應該 destination 的 Access Token 詳情
        const { accessToken, projectName } = await resolveProjectDetails(env, userId, destination);

        if (!accessToken) {
            logger.error('AUTH', `完全找不到 userId ${userId} 對應 destination ${destination} 的 Access Token`);
            return new Response('OK', { status: 200 });
        }

        logger.info('AUTH', `路由成功: 使用專案 "${projectName}" 處理請求`);

        // 4. 事件非同步處理 (優化用戶體驗與系統穩定性)
        const events = body.events || [];
        const processEvents = async () => {
            for (const event of events) {
                try {
                    logger.info('EVENT', `處理背景事件: ${event.type}`, { replyToken: event.replyToken });
                    await routeEvent(event, env, userId, accessToken, ctx, destination);
                } catch (err) {
                    logger.error('EVENT', `處理事件 ${event.type} 失敗`, err);
                }
            }
            logger.info('PERFORMANCE', `處理完成，耗時: ${Date.now() - startTime}ms`);
        };

        if (ctx?.waitUntil) {
            ctx.waitUntil(processEvents());
        } else {
            logger.warn('SYSTEM', '不支援 waitUntil，改為並行非等待處理');
            processEvents();
        }

        return new Response('OK', { status: 200 });

    } catch (error) {
        logger.error('GLOBAL', 'Webhook 處理異常', error);
        return new Response('OK', { status: 200 });
    }
}

/**
 * resolveProjectDetails
 * 根據 userId 和 destination 尋找對應的專案名稱與 Token
 * 
 * Pre-conditions: userId, destination 有效
 * Post-conditions: 回傳 { accessToken, projectName }
 */
async function resolveProjectDetails(env, userId, destination) {
    if (!env || !userId || !destination) {
        return { accessToken: null, projectName: null };
    }

    // 優先精確配置匹配
    const byDestination = await getAccessTokenForDestination(env, userId, destination);
    if (byDestination.token) {
        return { accessToken: byDestination.token, projectName: byDestination.projectName };
    }

    // 降級兼容：使用當前選中專案 (支援舊版無 destination 標記的情況)
    const currentProject = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    const currentToken = await getCurrentAccessToken(env, userId);
    if (currentToken) {
        return { accessToken: currentToken, projectName: currentProject };
    }

    return { accessToken: null, projectName: null };
}

/**
 * routeEvent
 * 事件分發邏輯
 * 
 * Pre-conditions: 事件類型、環境變數與 Token 已就緒
 */
async function routeEvent(event, env, userId, accessToken, ctx, destination) {
    if (!event || !event.type || !env || !userId) {
        logger.error('EVENT', 'routeEvent 收到無效的事件結構');
        return null;
    }

    // destination 就是 botId，每一種事件都要拿到它：它決定資料寫進哪個
    // 命名空間（bot:${botId}:*）。少了它，同一個 owner 底下兩個官方帳號的
    // 會員會混在一起，而且事後分不回去。
    switch (event.type) {
        case 'message':
            return EventHandler.handleMessageEvent(event, env, userId, accessToken, ctx, destination);
        case 'follow':
            return EventHandler.handleFollowEvent(event, env, userId, accessToken, ctx, destination);
        case 'unfollow':
            return EventHandler.handleUnfollowEvent(event, env, userId, destination);
        case 'postback':
            return EventHandler.handlePostbackEvent(event, env, userId, accessToken, ctx, destination);
        default:
            logger.debug('EVENT', `跳過不處理的事件類型: ${event.type}`);
            return null;
    }
}

/**
 * route
 * 外部路由進入點
 */
export function route(request, env, userId, pathname, ctx) {
    if (!request || !env || !pathname) {
        return null;
    }

    if (pathname === "/api/webhook" && request.method === "POST") {
        return handleWebhookRequest(request, env, ctx);
    }
    return null;
}
