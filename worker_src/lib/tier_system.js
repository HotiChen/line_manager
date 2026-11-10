/**
 * 會員等級系統核心邏輯
 *
 * 所有函式收 BotStore 而不是 (env, userId)：等級設定與會員 profile 都是
 * per-bot 的資料，而 botId 只有呼叫端知道（後台看的是使用者選的 bot，
 * webhook 看的是 LINE 的 destination）。在這一層自己去猜等於把
 * 「寫錯官方帳號」變成一個不會報錯的 bug。
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
export async function getTierConfig(store) {
    const config = await store.get('tierConfig');
    if (!config) {
        await store.put('tierConfig', DEFAULT_TIER_CONFIG);
        return DEFAULT_TIER_CONFIG;
    }
    return { ...DEFAULT_TIER_CONFIG, ...config };
}

/**
 * updateTierConfig
 * 更新等級全局配置
 */
export async function updateTierConfig(store, newConfig) {
    const current = await getTierConfig(store);
    const merged = { ...current, ...newConfig };
    await store.put('tierConfig', merged);
    return merged;
}

/**
 * setMemberTier
 * 手動設定特定會員等級
 */
export async function setMemberTier(store, lineUserId, tier) {
    const profile = await store.getOr('member', {}, lineUserId);

    if (!profile.memberId) {
        return { success: false, error: "會員不存在" };
    }

    const oldTier = profile.tier || 0;
    profile.tier = tier;
    profile.lastTierUpdate = new Date().toISOString();
    profile.tierSetBy = "manual";
    await store.put('member', profile, lineUserId);

    return { success: true, oldTier, newTier: tier };
}

/**
 * getTierStatistics
 * 取得各等級的會員統計數據
 */
export async function getTierStatistics(store) {
    const config = await getTierConfig(store);
    // listIds 回新舊兩個命名空間的聯集，所以回填期間不會少算會員
    const memberIds = await store.listIds('member');

    const stats = {};
    for (const t of config.tiers) {
        stats[t.id] = { name: t.name, icon: t.icon, count: 0 };
    }

    for (const memberId of memberIds) {
        const profile = await store.get('member', memberId);
        const tierId = profile?.tier || 0;
        if (stats[tierId]) {
            stats[tierId].count++;
        }
    }

    return { tiers: stats, total: memberIds.length };
}

/**
 * getMemberTier
 * 取得特定會員目前等級資訊
 */
export async function getMemberTier(store, lineUserId) {
    const profile = await store.getOr('member', {}, lineUserId);
    const config = await getTierConfig(store);
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
export async function checkTierUpgrade(store, lineUserId) {
    try {
        const profile = await store.getOr('member', {}, lineUserId);
        if (!profile?.memberId) return { upgraded: false, tier: 0 };

        const config = await getTierConfig(store);
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
        await store.put('member', profile, lineUserId);

        if (config.benefits?.richMenu?.enabled) {
            await syncTierRichMenu(store, lineUserId, newTier);
        }

        return { upgraded: true, oldTier: currentTier, newTier };
    } catch (e) {
        logger.error('TIER', '升級檢查錯誤', e);
        return { upgraded: false, tier: 0 };
    }
}

async function syncTierRichMenu(store, lineUserId, tierId) {
    // token 的存放不在 bot_store 的管轄範圍（見 token_store.js），仍以 owner 為 key
    const accessToken = await getCurrentAccessToken(store.env, store.userId);
    if (accessToken) {
        await applyTierRichMenu(store, lineUserId, tierId, accessToken);
    }
}

function calculateDaysSince(date) {
    if (!date) return 0;
    return Math.ceil(Math.abs(new Date() - new Date(date)) / (1000 * 60 * 60 * 24));
}

export async function applyTierRichMenu(store, lineUserId, tierId, accessToken) {
    const config = await getTierConfig(store);
    const tier = config.tiers.find(t => t.id === tierId);
    if (!tier) return;

    if (tier.richMenuId) {
        await linkRichMenuToUser(lineUserId, tier.richMenuId, accessToken);
    } else {
        await unlinkRichMenuFromUser(lineUserId, accessToken);
    }
}
