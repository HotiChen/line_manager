// worker_src/lib/quick_reply.js
// Quick Reply 模板讀取（關鍵字回覆與 flow 共用）
import * as logger from '../utils/logger.js';

/**
 * @returns {Promise<{items: object[]}|null>} 模板不存在或沒有項目回 null
 */
export async function getQuickReplyTemplate(store, qrId) {
    try {
        // bot_store 的雙讀會處理新舊命名空間
        const qrList = await store.getOr('quickReplies', []);
        const qr = Array.isArray(qrList) ? qrList.find((q) => q.id === qrId) : null;
        if (!qr || !qr.items || qr.items.length === 0) {
            logger.debug('QR', `Quick Reply 模板 ${qrId} 不存在或無項目`);
            return null;
        }
        return {
            items: qr.items.map((item) => ({ type: 'action', action: item.action })),
        };
    } catch (err) {
        logger.error('QR', '取得 Quick Reply 模板失敗', err);
        return null;
    }
}
