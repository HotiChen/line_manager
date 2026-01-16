/**
 * 會員等級系統核心邏輯
 * 負責等級配置、升級檢查、等級資訊取得
 */

import * as logger from '../utils/logger.js';
import { getLineUserProfile, linkRichMenuToUser, unlinkRichMenuFromUser } from './line_client.js';

// 預設等級配置
const DEFAULT_TIER_CONFIG = {
    upgradeRules: {
        interactions: {
            enabled: true,
            rules: [
                { tier: 0, interactions: 0, name: "新手" },
                { tier: 1, interactions: 10, name: "一般" },
                { tier: 2, interactions: 50, name: "VIP" },
                { tier: 3, interactions: 200, name: "SVIP" }
            ]
        },
        timeBased: {
            enabled: true,
            rules: [
                { tier: 0, days: 0, name: "新手" },
                { tier: 1, days: 7, name: "一般" },
                { tier: 2, days: 30, name: "VIP" },
                { tier: 3, days: 90, name: "SVIP" }
            ]
        },
        manual: { enabled: true }
    },
    benefits: {
        customTitle: { enabled: true },
        richMenu: { enabled: false },
        tierSpecificReplies: { enabled: true }
    },
    tiers: [
        { id: 0, name: "新手", title: "親愛的", icon: "🌱", color: "#4caf50" },
        { id: 1, name: "一般", title: "會員", icon: "⭐", color: "#2196f3" },
        { id: 2, name: "VIP", title: "尊貴的 VIP", icon: "💎", color: "#ff9800" },
        { id: 3, name: "SVIP", title: "至尊 SVIP", icon: "👑", color: "#f44336" }
    ],
    benefits: {
        richMenu: {
            enabled: false
        }
    }
};

/**
 * 取得等級配置
 */
export async function getTierConfig(env, userId) {
    const configKey = `tier_config_${userId}`;
    const config = await env.KV_LINE_STORAGE.get(configKey, { type: 'json' });

    if (!config) {
        // 首次使用，建立預設配置
        await env.KV_LINE_STORAGE.put(configKey, JSON.stringify(DEFAULT_TIER_CONFIG));
        return DEFAULT_TIER_CONFIG;
    }

    // 確保回傳完整的配置（合併預設值）
    return {
        ...DEFAULT_TIER_CONFIG,
        ...config,
        upgradeRules: {
            ...DEFAULT_TIER_CONFIG.upgradeRules,
            ...(config.upgradeRules || {})
        },
        benefits: {
            ...DEFAULT_TIER_CONFIG.benefits,
            ...(config.benefits || {})
        }
    };
}

/**
 * 更新等級配置
 */
export async function updateTierConfig(env, userId, config) {
    const configKey = `tier_config_${userId}`;
    await env.KV_LINE_STORAGE.put(configKey, JSON.stringify(config));
    logger.info('TIER', '等級配置已更新', { userId });
}

/**
 * 取得會員等級資訊
 */
export async function getMemberTier(env, userId, lineUserId) {
    const profileKey = `member_profile_${userId}_${lineUserId}`;
    const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

    if (!profile || Object.keys(profile).length === 0) {
        return {
            tier: 0,
            tierName: "新手",
            tierTitle: "親愛的",
            tierIcon: "🌱"
        };
    }

    const config = await getTierConfig(env, userId);
    const tierInfo = config.tiers.find(t => t.id === (profile.tier || 0));

    return {
        tier: profile.tier || 0,
        tierName: tierInfo?.name || "新手",
        tierTitle: tierInfo?.title || "親愛的",
        tierIcon: tierInfo?.icon || "🌱",
        tierColor: tierInfo?.color || "#4caf50"
    };
}

/**
 * 計算加入天數
 */
function calculateDaysSince(joinedAt) {
    if (!joinedAt) return 0;

    const joined = new Date(joinedAt);
    const now = new Date();
    const diffTime = Math.abs(now - joined);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
}

/**
 * 根據互動次數找到最高可達等級
 */
function findHighestTierByInteractions(interactions, rules) {
    let highestTier = rules[0];

    for (const rule of rules) {
        if (interactions >= rule.interactions && rule.tier > highestTier.tier) {
            highestTier = rule;
        }
    }

    return highestTier;
}

/**
 * 根據加入天數找到最高可達等級
 */
function findHighestTierByDays(days, rules) {
    let highestTier = rules[0];

    for (const rule of rules) {
        if (days >= rule.days && rule.tier > highestTier.tier) {
            highestTier = rule;
        }
    }

    return highestTier;
}

/**
 * 檢查並執行升級
 * @returns {Promise<{upgraded: boolean, oldTier?: number, newTier?: number, tier: number}>}
 */
export async function checkTierUpgrade(env, userId, lineUserId) {
    try {
        const profileKey = `member_profile_${userId}_${lineUserId}`;
        const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

        if (!profile || Object.keys(profile).length === 0) {
            logger.warn('TIER', '會員資料不存在，無法檢查升級', { lineUserId });
            return { upgraded: false, tier: 0 };
        }

        const config = await getTierConfig(env, userId);
        const currentTier = profile.tier || 0;
        let newTier = currentTier;

        // 1. 檢查互動次數規則
        if (config.upgradeRules.interactions.enabled) {
            const interactions = profile.totalInteractions || 0;
            const rule = findHighestTierByInteractions(
                interactions,
                config.upgradeRules.interactions.rules
            );
            newTier = Math.max(newTier, rule.tier);
        }

        // 2. 檢查時間規則
        if (config.upgradeRules.timeBased.enabled) {
            const daysSinceJoin = calculateDaysSince(profile.joinedAt);
            const rule = findHighestTierByDays(
                daysSinceJoin,
                config.upgradeRules.timeBased.rules
            );
            newTier = Math.max(newTier, rule.tier);
        }

        // 3. 執行升級
        if (newTier > currentTier) {
            profile.tier = newTier;
            profile.lastTierUpdate = new Date().toISOString();

            // 更新等級名稱
            const tierInfo = config.tiers.find(t => t.id === newTier);
            if (tierInfo) {
                profile.tierName = tierInfo.name;
            }

            await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));

            // 🆕 如果啟用了 Rich Menu 權益，則執行選單切換 (異步)
            // 重新取得 config 是為了確保是最新的，儘管此處 config 已經存在
            const updatedConfig = await getTierConfig(env, userId);
            if (updatedConfig.benefits?.richMenu?.enabled) {
                // 此處因為是背景執行，我們需要 accessToken。
                // 由於 checkTierUpgrade 的 caller 通常在背景任務（ctx.waitUntil），
                // 且目前架構中 webhook 已經有 accessToken，但 checkTierUpgrade 沒傳。
                // 我們可以從專案反查 accessToken，或者修改參數。
                // 為了不破壞現有簽名，我們先嘗試從專案反查。
                try {
                    const tokenMap = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: 'json' }) || {};
                    const currentProject = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
                    const currentData = tokenMap[currentProject];
                    const accessToken = typeof currentData === 'string' ? currentData : currentData?.token;

                    if (accessToken) {
                        // 不要等待選單切換完成，避免阻塞
                        applyTierRichMenu(env, userId, lineUserId, newTier, accessToken);
                    } else {
                        logger.warn('TIER', '自動切換 Rich Menu 失敗: 找不到 Access Token', { userId, lineUserId });
                    }
                } catch (e) {
                    logger.error('TIER', '自動切換 Rich Menu 失敗 (Token 獲取失敗)', e);
                }
            }

            logger.info('TIER', `會員升級成功`, {
                lineUserId,
                oldTier: currentTier,
                newTier: newTier,
                tierName: tierInfo?.name
            });

            return {
                upgraded: true,
                oldTier: currentTier,
                newTier: newTier,
                tierName: tierInfo?.name,
                tier: newTier
            };
        }

        return { upgraded: false, tier: currentTier };

    } catch (error) {
        logger.error('TIER', `升級檢查失敗: ${error.message}`, error);
        return { upgraded: false, tier: 0, error: error.message };
    }
}

/**
 * 手動設定會員等級
 */
export async function setMemberTier(env, userId, lineUserId, tier) {
    try {
        const profileKey = `member_profile_${userId}_${lineUserId}`;
        const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

        if (!profile || Object.keys(profile).length === 0) {
            throw new Error('會員資料不存在');
        }

        const config = await getTierConfig(env, userId);
        const tierInfo = config.tiers.find(t => t.id === tier);

        if (!tierInfo) {
            throw new Error('無效的等級 ID');
        }

        const oldTier = profile.tier || 0;
        profile.tier = tier;
        profile.tierName = tierInfo.name;
        profile.lastTierUpdate = new Date().toISOString();
        profile.tierManuallySet = true; // 標記為手動設定

        await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));

        logger.info('TIER', `手動設定等級`, {
            lineUserId,
            oldTier,
            newTier: tier,
            tierName: tierInfo.name
        });

        return { success: true, oldTier, newTier: tier, tierName: tierInfo.name };

    } catch (error) {
        logger.error('TIER', `手動設定等級失敗: ${error.message}`, error);
        return { success: false, error: error.message };
    }
}

/**
 * 取得等級稱呼（用於訊息變數替換）
 */
export function getTierTitle(tierInfo) {
    if (typeof tierInfo === 'object') {
        return tierInfo.tierTitle || "親愛的";
    }
    // 向下相容：如果傳入的是 tier ID
    return "親愛的";
}

/**
 * 取得所有會員的等級分布統計
 */
export async function getTierStatistics(env, userId) {
    try {
        const listKey = `member_list_${userId}`;
        const memberIds = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || "[]");

        const stats = {
            total: memberIds.length,
            tiers: { 0: 0, 1: 0, 2: 0, 3: 0 }
        };

        // TODO: 迴圈檢查所有會員會導致 CPU Timeout，暫時回傳空統計
        return stats;

    } catch (error) {
        logger.error('TIER', `統計失敗: ${error.message}`, error);
        return { total: 0, tiers: { 0: 0, 1: 0, 2: 0, 3: 0 } };
    }
}

/**
 * 根據等級套用 Rich Menu
 * @param {Object} env 
 * @param {string} userId 專案擁有者 ID
 * @param {string} lineUserId LINE 使用者 ID
 * @param {number} tierId 等級 ID
 * @param {string} accessToken LINE Access Token
 */
export async function applyTierRichMenu(env, userId, lineUserId, tierId, accessToken) {
    try {
        const config = await getTierConfig(env, userId);
        const tier = config.tiers.find(t => t.id === tierId);

        if (!tier) {
            logger.warn('TIER', `找不到等級 ${tierId} 的資訊，無法切換 Rich Menu`);
            return;
        }

        const richMenuId = tier.richMenuId;

        if (richMenuId) {
            logger.info('TIER', `執行等級專屬 Rich Menu 切換: ${lineUserId} -> ${richMenuId}`);
            const success = await linkRichMenuToUser(lineUserId, richMenuId, accessToken);
            logger.info('TIER', `Rich Menu 連結結果: ${success ? '成功' : '失敗'}`);
        } else {
            // 如果該等級沒有設定專屬選單，則取消個別綁定（讓使用者回歸預設選單）
            logger.info('TIER', `等級 ${tierId} 未設定選單，解除 ${lineUserId} 的個別綁定`);
            const success = await unlinkRichMenuFromUser(lineUserId, accessToken);
            logger.info('TIER', `Rich Menu 解除連結結果: ${success ? '成功' : '失敗'}`);
        }
    } catch (error) {
        logger.error('TIER', '套用等級 Rich Menu 失敗', error);
    }
}
