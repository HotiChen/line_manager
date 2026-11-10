/**
 * 會員等級系統核心邏輯
 */
import * as logger from '../utils/logger.js';
import { linkRichMenuToUser, unlinkRichMenuFromUser } from './line_client.js';
import { getCurrentAccessToken } from './token_store.js';

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
    tiers: [
        { id: 0, name: "新手", title: "親愛的", icon: "🌱", color: "#4caf50" },
        { id: 1, name: "一般", title: "會員", icon: "⭐", color: "#2196f3" },
        { id: 2, name: "VIP", title: "尊貴的 VIP", icon: "💎", color: "#ff9800" },
        { id: 3, name: "SVIP", title: "至尊 SVIP", icon: "👑", color: "#f44336" }
    ],
    benefits: {
        richMenu: { enabled: false }
    }
};

/**
 * getTierConfig
 * 取得等級全局配置
 */
export async function getTierConfig(env, userId) {
    const key = `tier_config_${userId}`;
    const config = await env.KV_LINE_STORAGE.get(key, { type: 'json' });
    if (!config) {
        await env.KV_LINE_STORAGE.put(key, JSON.stringify(DEFAULT_TIER_CONFIG));
        return DEFAULT_TIER_CONFIG;
    }
    return { ...DEFAULT_TIER_CONFIG, ...config };
}

/**
 * updateTierConfig
 * 更新等級全局配置
 */
export async function updateTierConfig(env, userId, newConfig) {
    const key = `tier_config_${userId}`;
    const current = await getTierConfig(env, userId);
    const merged = { ...current, ...newConfig };
    await env.KV_LINE_STORAGE.put(key, JSON.stringify(merged));
    return merged;
}

/**
 * setMemberTier
 * 手動設定特定會員等級
 */
export async function setMemberTier(env, userId, lineUserId, tier) {
    const profileKey = `member_profile_${userId}_${lineUserId}`;
    const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

    if (!profile.memberId) {
        return { success: false, error: "會員不存在" };
    }

    const oldTier = profile.tier || 0;
    profile.tier = tier;
    profile.lastTierUpdate = new Date().toISOString();
    profile.tierSetBy = "manual";
    await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));

    return { success: true, oldTier, newTier: tier };
}

/**
 * getTierStatistics
 * 取得各等級的會員統計數據
 */
export async function getTierStatistics(env, userId) {
    const config = await getTierConfig(env, userId);
    const prefix = `member_profile_${userId}_`;
    const list = await env.KV_LINE_STORAGE.list({ prefix });

    const stats = {};
    for (const t of config.tiers) {
        stats[t.id] = { name: t.name, icon: t.icon, count: 0 };
    }

    for (const key of list.keys) {
        const profile = await env.KV_LINE_STORAGE.get(key.name, { type: "json" });
        const tierId = profile?.tier || 0;
        if (stats[tierId]) {
            stats[tierId].count++;
        }
    }

    return { tiers: stats, total: list.keys.length };
}

/**
 * getMemberTier
 * 取得特定會員目前等級資訊
 */
export async function getMemberTier(env, userId, lineUserId) {
    const profile = JSON.parse(await env.KV_LINE_STORAGE.get(`member_profile_${userId}_${lineUserId}`) || "{}");
    const config = await getTierConfig(env, userId);
    const tierId = profile.tier || 0;
    const info = config.tiers.find(t => t.id === tierId) || config.tiers[0];

    return {
        tier: tierId,
        tierName: info.name,
        tierTitle: info.title,
        tierIcon: info.icon,
        tierColor: info.color
    };
}

/**
 * checkTierUpgrade
 * 評估並執行自動升級邏輯
 * 
 * Post-conditions:
 * - 若符合條件則更新會員等級並同步選單
 */
export async function checkTierUpgrade(env, userId, lineUserId) {
    try {
        const profileKey = `member_profile_${userId}_${lineUserId}`;
        const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");
        if (!profile?.memberId) return { upgraded: false, tier: 0 };

        const config = await getTierConfig(env, userId);
        const currentTier = profile.tier || 0;
        let newTier = currentTier;

        if (config.upgradeRules.interactions.enabled) {
            const interactions = profile.totalInteractions || 0;
            const match = config.upgradeRules.interactions.rules
                .filter(r => interactions >= r.interactions)
                .sort((a, b) => b.tier - a.tier)[0];
            if (match) newTier = Math.max(newTier, match.tier);
        }

        if (config.upgradeRules.timeBased.enabled) {
            const days = calculateDaysSince(profile.joinedAt);
            const match = config.upgradeRules.timeBased.rules
                .filter(r => days >= r.days)
                .sort((a, b) => b.tier - a.tier)[0];
            if (match) newTier = Math.max(newTier, match.tier);
        }

        if (newTier <= currentTier) return { upgraded: false, tier: currentTier };

        profile.tier = newTier;
        profile.lastTierUpdate = new Date().toISOString();
        await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));

        if (config.benefits?.richMenu?.enabled) {
            await syncTierRichMenu(env, userId, lineUserId, newTier);
        }

        return { upgraded: true, oldTier: currentTier, newTier };
    } catch (e) {
        logger.error('TIER', '升級檢查錯誤', e);
        return { upgraded: false, tier: 0 };
    }
}

async function syncTierRichMenu(env, userId, lineUserId, tierId) {
    const accessToken = await getCurrentAccessToken(env, userId);
    if (accessToken) {
        await applyTierRichMenu(env, userId, lineUserId, tierId, accessToken);
    }
}

function calculateDaysSince(date) {
    if (!date) return 0;
    return Math.ceil(Math.abs(new Date() - new Date(date)) / (1000 * 60 * 60 * 24));
}

export async function applyTierRichMenu(env, userId, lineUserId, tierId, accessToken) {
    const config = await getTierConfig(env, userId);
    const tier = config.tiers.find(t => t.id === tierId);
    if (!tier) return;

    if (tier.richMenuId) {
        await linkRichMenuToUser(lineUserId, tier.richMenuId, accessToken);
    } else {
        await unlinkRichMenuFromUser(lineUserId, accessToken);
    }
}
