/**
 * LINE Webhook 事件處理器
 * 處理各種 LINE 事件類型
 *
 * ## botId 從哪裡來
 *
 * 每個 export 的事件處理器都收一個 botId —— LINE webhook body 的
 * `destination`，由 webhook.js 傳進來。那是這個事件屬於哪個官方帳號的
 * 唯一權威來源。
 *
 * **不可以用 resolveBotId(userId) 回推。** 那回傳的是「這個 owner 現在
 * 在後台選的 bot」，而 webhook 完全不受後台操作影響：owner 正在看 B 帳號
 * 的時候，A 帳號收到的訊息會被寫進 B 的命名空間 —— 不會報錯，只是會員
 * 跑到隔壁去，而且事後分不回來。
 */
import * as logger from '../utils/logger.js';
import { findMatchingKeyword } from './keyword_matcher.js';
import { formatReplyMessage, getLineUserProfile, normalizeImagemapActions, replyWithRetry } from './line_client.js';
import { incrementMessageCount } from './message_stats.js';
import { syncMemberRichMenu } from './segmented_richmenu_logic.js';
import { addTagsToEntity, removeTagsFromEntity } from './tag_system.js';
import { getMemberTier, checkTierUpgrade } from './tier_system.js';
import { openBotStoreFor } from './bot_store.js';

/**
 * 把 botId 併進會員的 botIds。
 *
 * 會員資料的 key 綁 owner 不綁 bot（member_profile_${ownerId}_${lineUserId}），
 * 所以同一個人追蹤同一個 owner 的兩個官方帳號時只有一筆記錄 —— 單一欄位
 * 記不下兩個，記成陣列，將來 migration 才能把他複製到兩邊的命名空間。
 *
 * botId 無效時原樣回傳，不寫入任何東西：寧可留著「不知道」，也不要存一個
 * 看起來有答案的垃圾值。
 *
 * @param {Object} profile
 * @param {unknown} botId - LINE 的 destination
 * @returns {Object} 同一個 profile 物件
 */
function withBotId(profile, botId) {
    if (typeof botId !== 'string' || botId === '' || botId.includes(':')) return profile;
    const existing = Array.isArray(profile.botIds) ? profile.botIds : [];
    profile.botIds = existing.includes(botId) ? existing : [...existing, botId];
    return profile;
}

/**
 * 助手函數：紀錄新會員或更新互動
 *
 * @param {string} [botId] - 事件來源的 LINE destination。缺少時會員照常建立，
 *   只是這筆資料無法歸屬到特定官方帳號。
 */
async function recordMemberInteraction(event, store, accessToken, botId) {
    try {
        const lineUserId = event.source.userId;

        logger.info('RECORD_MEMBER', `開始記錄會員互動: ${lineUserId}`);

        let profile = await store.getOr('member', {}, lineUserId);
        const isNew = !profile.memberId;

        logger.info('RECORD_MEMBER', `會員狀態: ${isNew ? '新會員' : '現有會員'}`);

        if (isNew) {
            // 新會員，從 LINE API 撈取基本資料
            const lineProfile = await getLineUserProfile(lineUserId, accessToken);
            profile = {
                memberId: lineUserId,
                lineName: lineProfile?.displayName || "未知用戶",
                pictureUrl: lineProfile?.pictureUrl || "",
                status: "active",
                joinedAt: new Date().toISOString(),
                tags: [],
                totalInteractions: 1,
                lastInteraction: new Date().toISOString()
            };
            withBotId(profile, botId);

            // 更新會員列表
            const list = await store.getOr('members', []);
            if (!list.includes(lineUserId)) {
                list.push(lineUserId);
                await store.put('members', list);
            }
            logger.info('RECORD_MEMBER', '新會員資料已建立');
        } else {
            profile.status = "active";
            profile.totalInteractions = (profile.totalInteractions || 0) + 1;
            profile.lastInteraction = new Date().toISOString();
            // 既有會員在下次互動時補上歸屬，讓舊資料逐步收斂
            withBotId(profile, botId);
            logger.info('RECORD_MEMBER', '現有會員資料已更新');
        }

        await store.put('member', profile, lineUserId);
        logger.info('RECORD_MEMBER', '會員資料已儲存至 KV');
        return profile;
    } catch (error) {
        logger.error('RECORD_MEMBER', `記錄會員互動失敗: ${error.message}`, error);
        throw error; // 重新拋出讓上層處理
    }
}
/**
 * 替換訊息中的變數
 * 支援: (@name), (@tier), (@tier_name), (@tier_icon), (@date), (@time), (@day), (@year), (@month)
 */
function replaceMessageVariables(messages, variables) {
    const { userName, tierInfo } = variables;

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

    // 替換變數對照表 (確保所有值皆為字串)
    const replacements = {
        '(@name)': String(userName || '用戶'),
        '(@tier)': String(tierInfo?.tierTitle || '親愛的'),
        '(@tier_name)': String(tierInfo?.tierName || '新手'),
        '(@tier_icon)': String(tierInfo?.tierIcon || '🌱'),
        '(@date)': String(`${year}/${month}/${date}`),
        '(@time)': String(`${hours}:${minutes}`),
        '(@day)': String(`星期${dayOfWeek}`),
        '(@year)': String(year),
        '(@month)': String(month),
    };

    for (const msg of messages) {
        if (msg.type === 'text' && msg.text) {
            for (const [key, value] of Object.entries(replacements)) {
                // 將 (@name) 轉為 \(@name\) 以便於正則匹配
                const escapedKey = key.replace(/[()]/g, '\\$&');
                msg.text = msg.text.replace(new RegExp(escapedKey, 'gi'), value);
            }
        }
        if (msg.type === 'flex' && msg.altText) {
            for (const [key, value] of Object.entries(replacements)) {
                const escapedKey = key.replace(/[()]/g, '\\$&');
                msg.altText = msg.altText.replace(new RegExp(escapedKey, 'gi'), value);
            }
        }
    }

    return messages;
}
/**
 * 取得 Quick Reply 模板
 */
async function getQuickReplyTemplate(store, qrId) {
    try {
        // 原本在這裡試三個 key，其中 `bot:${userId}:quick_replies` 把 userId
        // 放進了 botId 的位置，永遠對不到。bot_store 的雙讀取代了這整段。
        const qrList = await store.getOr('quickReplies', []);
        logger.info('QR', `共 ${qrList.length} 個模板`);
        const qr = Array.isArray(qrList) ? qrList.find(q => q.id === qrId) : null;
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
export async function handleMessageEvent(event, env, userId, accessToken, ctx, botId) {
    const store = openBotStoreFor(env, userId, botId);
    if (event.message.type !== 'text') {
        logger.info('MESSAGE', `收到非文字訊息: ${event.message.type}`);
        return;
    }
    const userMessage = event.message.text.trim();
    const lineUserId = event.source.userId;
    logger.info('MESSAGE', `使用者訊息: "${userMessage}"`);
    // 載入關鍵字列表
    const keywordList = await store.getOr('keywords', []);
    // 追蹤偵錯：輸出關鍵字清單摘要 (僅用於排除 testVip 問題)
    if (userMessage.toLowerCase().includes('test')) {
        logger.debug('TRACER', `偵測到測試訊息 "${userMessage}"，目前關鍵字清單：${keywordList.map(k => k.keyword).join(', ')}`);
    }

    // 匹配關鍵字
    const match = findMatchingKeyword(userMessage, keywordList);
    if (!match) {
        logger.debug('MATCH', `未找到匹配的關鍵字: "${userMessage}" (清單共 ${keywordList.length} 個)`);
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
    // 🆕 取得使用者名稱與等級資訊並替換變數 (並行處理 + 逾時保護)
    let memberProfile = null;
    try {
        // 使用 Promise.all 並行獲取所需資訊
        const [storedProfile, lineProfile, tierData] = await Promise.all([
            store.get('member', lineUserId),
            // 為外部 API 提供 2 秒逾時保護
            Promise.race([
                getLineUserProfile(lineUserId, accessToken),
                new Promise(resolve => setTimeout(() => resolve(null), 2000))
            ]),
            getMemberTier(store, lineUserId)
        ]);

        memberProfile = storedProfile || {};
        const userName = lineProfile?.displayName || '用戶';
        const tierInfo = tierData || { tierName: '新手', tierTitle: '親愛的' };

        validMessages = replaceMessageVariables(validMessages, { userName, tierInfo });
        logger.debug('REPLACE_VAR', `變數替換完成: userName=${userName}, tier=${tierInfo.tierName}`);
    } catch (err) {
        logger.error('REPLACE_VAR', '並行獲取變數或替換失敗', err);
    }

    // 處理 keyword-level 的 Quick Reply
    let qrId = match.quickReplyId;
    if (!qrId) {
        const replyWithQR = match.replies.find(r => r.quickReplyId);
        if (replyWithQR) qrId = replyWithQR.quickReplyId;
    }
    if (qrId && validMessages.length > 0) {
        const quickReply = await getQuickReplyTemplate(store, qrId);
        if (quickReply) {
            validMessages[validMessages.length - 1].quickReply = quickReply;
        }
    }

    // --- [背景任務區] 使用 ctx.waitUntil 異步處理 ---
    if (ctx && ctx.waitUntil) {
        ctx.waitUntil((async () => {
            try {
                // 1. 紀錄互動、檢查升級與自動標籤
                if (memberProfile && Object.keys(memberProfile).length > 0) {
                    let profileChanged = false;

                    // 更新互動
                    memberProfile.totalInteractions = (memberProfile.totalInteractions || 0) + 1;
                    memberProfile.lastInteraction = new Date().toISOString();
                    profileChanged = true;

                    // 檢查等級升級
                    const upgradeResult = await checkTierUpgrade(store, lineUserId);
                    if (upgradeResult.upgraded) {
                        logger.info('TIER', `🎉 會員升級: ${lineUserId} -> ${upgradeResult.tierName}`);
                        const freshlyUpgradedProfile = await store.getOr('member', {}, lineUserId);
                        memberProfile = { ...memberProfile, ...freshlyUpgradedProfile };
                    }

                    // 自動標籤
                    if (match.addTags || match.removeTags) {
                        const addTags = Array.isArray(match.addTags) ? match.addTags : (match.addTag ? [match.addTag] : []);
                        const removeTags = Array.isArray(match.removeTags) ? match.removeTags : [];

                        if (addTags.length > 0 || removeTags.length > 0) {
                            memberProfile.tags = memberProfile.tags || [];
                            for (const tag of addTags) {
                                if (tag && tag.trim() && !memberProfile.tags.includes(tag.trim())) {
                                    memberProfile.tags.push(tag.trim());
                                }
                            }
                            for (const tag of removeTags) {
                                if (tag && tag.trim()) {
                                    memberProfile.tags = memberProfile.tags.filter(t => t !== tag.trim());
                                }
                            }
                            profileChanged = true;
                        }
                    }

                    if (profileChanged) {
                        await store.put('member', memberProfile, lineUserId);
                    }
                }

                // 2. 增加統計數據
                await incrementKeywordStat(store, match.keyword);
                await incrementMessageCount(store, 'reply');
            } catch (bgError) {
                logger.error('BACKGROUND', '背景任務執行失敗', bgError);
            }
        })());
    } else {
        // 沒有支援 waitUntil 的環境 (例如本地測試)，同步處理
        logger.warn('SYSTEM', '環境不支援 waitUntil，改為同步處理背景任務');
    }

    // 發送回覆 (盡快發送)
    try {
        logger.info('REPLY', `準備發送 ${validMessages.length} 則訊息到 ${lineUserId}`);
        await replyWithRetry(event.replyToken, validMessages, accessToken);
        logger.info('REPLY', `回覆成功發送至 ${lineUserId}`);
    } catch (error) {
        logger.error('REPLY', `回覆發送失敗: ${error.message}`, error);
        throw error;
    }
}
/**
 * 處理 Follow 事件
 */
export async function handleFollowEvent(event, env, userId, accessToken, ctx, botId) {
    const store = openBotStoreFor(env, userId, botId);
    const lineUserId = event.source.userId;
    logger.info('FOLLOW', `新用戶加入: ${lineUserId}`);

    // 紀錄會員並同步選單
    await recordMemberInteraction(event, store, accessToken, botId);
    await syncMemberRichMenu(store, lineUserId);

    try {
        const welcomeConfig = await store.get('welcome');
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
                const quickReply = await getQuickReplyTemplate(store, qrId);
                if (quickReply) {
                    validMessages[validMessages.length - 1].quickReply = quickReply;
                    logger.info('QR', `已附加 QR 到歡迎訊息`);
                }
            }
            if (validMessages.length > 0) {
                await replyWithRetry(event.replyToken, validMessages, accessToken);
                await incrementMessageCount(store, 'reply');
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
export async function handleUnfollowEvent(event, env, userId, botId) {
    const store = openBotStoreFor(env, userId, botId);
    const lineUserId = event.source.userId;
    logger.info('UNFOLLOW', `用戶封鎖: ${lineUserId}`);

    // 更新狀態為 inactive
    const profile = await store.get('member', lineUserId);
    if (profile) {
        profile.status = "inactive";
        await store.put('member', profile, lineUserId);
    }
}
/**
 * 處理 Postback 事件
 */
export async function handlePostbackEvent(event, env, userId, accessToken, ctx, botId) {
    const store = openBotStoreFor(env, userId, botId);
    const postbackData = event.postback.data;
    const lineUserId = event.source.userId;
    logger.info('POSTBACK', `收到 Postback: ${postbackData}`);

    // 🆕 自動標籤系統 (Postback Level) - 極簡版
    // 支援格式: tag=VIP, untag=Normal 或 URL query style
    try {
        const params = new URLSearchParams(postbackData);
        const tagToAdd = params.get('tag');
        const tagToRemove = params.get('untag');

        if (tagToAdd || tagToRemove) {
            const profile = await store.getOr('member', {}, lineUserId);

            if (profile && Object.keys(profile).length > 0) {
                profile.tags = profile.tags || [];

                // 添加標籤
                if (tagToAdd && tagToAdd.trim() && !profile.tags.includes(tagToAdd.trim())) {
                    profile.tags.push(tagToAdd.trim());
                    logger.info('AUTO_TAG', `Postback 自動添加標籤: ${tagToAdd.trim()}`);
                }

                // 移除標籤
                if (tagToRemove && tagToRemove.trim()) {
                    profile.tags = profile.tags.filter(t => t !== tagToRemove.trim());
                    logger.info('AUTO_TAG', `Postback 自動移除標籤: ${tagToRemove.trim()}`);
                }

                await store.put('member', profile, lineUserId);
                logger.info('AUTO_TAG', `Postback 標籤更新完成 (極簡模式)`, { tags: profile.tags });
            }
        }
    } catch (e) {
        logger.error('AUTO_TAG', `Postback 標籤處理失敗: ${e.message}`, e);
        // 解析失敗則跳過，不中斷回覆
    }

    try {
        const message = {
            type: 'text',
            text: `✅ 已收到您的操作：${postbackData}`
        };
        await replyWithRetry(event.replyToken, [message], accessToken);
        await incrementMessageCount(store, 'reply');
    } catch (error) {
        logger.error('POSTBACK', '處理 Postback 失敗', error);
    }
}
/**
 * 增加關鍵字統計
 */
async function incrementKeywordStat(store, keyword) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const stats = await store.getOr('keywordStats', {});
    if (!stats[keyword]) {
        stats[keyword] = { total: 0, monthly: {} };
    }
    stats[keyword].total = (stats[keyword].total || 0) + 1;
    stats[keyword].monthly[currentMonth] = (stats[keyword].monthly[currentMonth] || 0) + 1;
    await store.put('keywordStats', stats);
    logger.debug('STATS', `關鍵字 "${keyword}" 統計 +1`);
}
