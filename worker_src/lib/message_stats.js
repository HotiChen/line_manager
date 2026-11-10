/**
 * Message Statistics Utility
 *
 * 收 BotStore 而不是 (env, userId)：訊息量是 per-bot 的（LINE 的免費額度
 * 本身就是 per 官方帳號計算），把兩個帳號的量加在一起看不出任何東西。
 */

/**
 * Increment message count for a user with categorization
 * @param {Object} env - Cloudflare Worker environment
 * @param {string} userId - The owner (user) ID
 * @param {string} type - Message type ('reply', 'push', 'broadcast')
 */
export async function incrementMessageCount(store, type = 'reply') {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    try {
        const stats = await store.getOr('messageStats', { total: 0, monthly: {} });

        // Ensure structure for new categories
        if (!stats.reply) stats.reply = 0;
        if (!stats.push) stats.push = 0;
        if (!stats.broadcast) stats.broadcast = 0;

        // Update total
        stats.total = (stats.total || 0) + 1;

        // Update category
        if (type === 'reply' || type === 'push' || type === 'broadcast') {
            stats[type] = (stats[type] || 0) + 1;
        }

        // Update monthly
        if (!stats.monthly) stats.monthly = {};
        if (!stats.monthly[currentMonth]) {
            stats.monthly[currentMonth] = { total: 0, reply: 0, push: 0, broadcast: 0 };
        }

        const monthlyStats = stats.monthly[currentMonth];
        // Handle migration of old monthly format (if it was just a number)
        if (typeof monthlyStats === 'number') {
            stats.monthly[currentMonth] = { total: monthlyStats, reply: monthlyStats, push: 0, broadcast: 0 };
        }

        stats.monthly[currentMonth].total = (stats.monthly[currentMonth].total || 0) + 1;
        if (type === 'reply' || type === 'push' || type === 'broadcast') {
            stats.monthly[currentMonth][type] = (stats.monthly[currentMonth][type] || 0) + 1;
        }

        await store.put('messageStats', stats);
    } catch (error) {
        console.error('[STATS] Failed to increment message count:', error);
    }
}

/**
 * Get message statistics for a user
 */
export async function getMessageStats(store) {
    try {
        const stats = await store.get('messageStats');
        if (!stats) return { total: 0, reply: 0, push: 0, broadcast: 0, monthly: {} };

        // Ensure defaults for missing fields
        return {
            total: stats.total || 0,
            reply: stats.reply || 0,
            push: stats.push || 0,
            broadcast: stats.broadcast || 0,
            monthly: stats.monthly || {}
        };
    } catch (error) {
        console.error('[STATS] Failed to get message stats:', error);
        return { total: 0, reply: 0, push: 0, broadcast: 0, monthly: {} };
    }
}
