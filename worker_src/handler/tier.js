/**
 * 會員等級設定 API Handler
 *
 * 注意：userId 由 index.js 的 auth middleware 驗證後傳入，
 * 不再從 request header 自行讀取。
 */

import { jsonResponse } from '../lib/utils.js';
import { getTierConfig, updateTierConfig, setMemberTier, getTierStatistics, applyTierRichMenu } from '../lib/tier_system.js';
import * as logger from '../utils/logger.js';

/**
 * 取得等級配置
 */
export async function handleGetTierConfig(request, env, userId) {
    try {
        if (!userId) {
            return jsonResponse({ error: '缺少使用者認證' }, 401);
        }

        const config = await getTierConfig(env, userId);
        return jsonResponse({ success: true, config });

    } catch (error) {
        logger.error('TIER_API', '取得等級配置失敗', error);
        return jsonResponse({ error: error.message }, 500);
    }
}

/**
 * 更新等級配置
 */
export async function handleUpdateTierConfig(request, env, userId) {
    try {
        if (!userId) {
            return jsonResponse({ error: '缺少使用者認證' }, 401);
        }

        const config = await request.json();
        await updateTierConfig(env, userId, config);

        return jsonResponse({ success: true, message: '等級配置已更新' });

    } catch (error) {
        logger.error('TIER_API', '更新等級配置失敗', error);
        return jsonResponse({ error: error.message }, 500);
    }
}

/**
 * 手動設定會員等級
 */
export async function handleSetMemberTier(request, env, userId) {
    try {
        if (!userId) {
            return jsonResponse({ error: '缺少使用者認證' }, 401);
        }

        const { lineUserId, tier } = await request.json();

        if (!lineUserId || tier === undefined) {
            return jsonResponse({ error: '缺少必要參數' }, 400);
        }

        const result = await setMemberTier(env, userId, lineUserId, tier);

        if (result.success) {
            // 🆕 手動設定後也嘗試同步 Rich Menu
            const config = await getTierConfig(env, userId);
            if (config.benefits?.richMenu?.enabled) {
                try {
                    const tokenMap = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: 'json' }) || {};
                    const currentProject = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
                    const currentData = tokenMap[currentProject];
                    const accessToken = typeof currentData === 'string' ? currentData : currentData?.token;

                    if (accessToken) {
                        // 不需要 await，在背景執行即可
                        applyTierRichMenu(env, userId, lineUserId, tier, accessToken);
                    }
                } catch (e) {
                    logger.error('TIER_API', '手動設定等級時切換 Rich Menu 失敗', e);
                }
            }
            return jsonResponse(result);
        } else {
            return jsonResponse(result, 400);
        }

    } catch (error) {
        logger.error('TIER_API', '設定會員等級失敗', error);
        return jsonResponse({ error: error.message }, 500);
    }
}

/**
 * 取得等級統計
 */
export async function handleGetTierStats(request, env, userId) {
    try {
        if (!userId) {
            return jsonResponse({ error: '缺少使用者認證' }, 401);
        }

        const stats = await getTierStatistics(env, userId);
        return jsonResponse({ success: true, stats });

    } catch (error) {
        logger.error('TIER_API', '取得等級統計失敗', error);
        return jsonResponse({ error: error.message }, 500);
    }
}
