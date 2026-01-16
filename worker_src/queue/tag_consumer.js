import { addTagsToEntity, removeTagsFromEntity } from '../lib/tag_system.js';
import { syncMemberRichMenu } from '../lib/segmented_richmenu_logic.js';
import * as logger from '../utils/logger.js';

/**
 * 處理單個標籤任務
 * @param {Object} message - Queue 訊息
 * @param {Object} env - Worker 環境
 */
async function processTagTask(message, env) {
    const { userId, lineUserId, addTags, removeTags, keyword } = message.body;

    logger.info('TAG_QUEUE', `處理標籤任務: ${keyword}`, { addTags, removeTags });

    try {
        let tagChanged = false;

        // 添加標籤
        if (addTags && addTags.length > 0) {
            await addTagsToEntity(env, userId, 'member', lineUserId, addTags);
            logger.info('TAG_QUEUE', `已添加標籤: ${addTags.join(',')}`);
            tagChanged = true;
        }

        // 移除標籤
        if (removeTags && removeTags.length > 0) {
            await removeTagsFromEntity(env, userId, 'member', lineUserId, removeTags);
            logger.info('TAG_QUEUE', `已移除標籤: ${removeTags.join(',')}`);
            tagChanged = true;
        }

        // 同步圖文選單
        if (tagChanged) {
            await syncMemberRichMenu(env, userId, lineUserId);
            logger.info('TAG_QUEUE', `已同步圖文選單`);
        }

        message.ack(); // 確認處理完成
    } catch (error) {
        logger.error('TAG_QUEUE', `處理失敗: ${error.message}`, error);
        message.retry(); // 重試
    }
}

/**
 * Queue Consumer 主函式
 * Cloudflare Queue 會呼叫這個函式
 * @param {Object} batch - 批次訊息
 * @param {Object} env - Worker 環境
 */
export async function handleTagQueue(batch, env) {
    logger.info('TAG_QUEUE', `收到批次任務: ${batch.messages.length} 個`);

    for (const message of batch.messages) {
        await processTagTask(message, env);
    }

    logger.info('TAG_QUEUE', `批次處理完成`);
}
