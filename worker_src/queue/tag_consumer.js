import { addTagsToEntity, removeTagsFromEntity } from '../lib/tag_system.js';
import { syncMemberRichMenu } from '../lib/segmented_richmenu_logic.js';
import * as logger from '../utils/logger.js';
import { openBotStoreFor } from '../lib/bot_store.js';

/**
 * 處理單個標籤任務
 * @param {Object} message - Queue 訊息
 * @param {Object} env - Worker 環境
 */
async function processTagTask(message, env) {
    // botId 由入隊的那一端帶過來（webhook 知道 LINE 的 destination）。
    // 這裡不可用 resolveBotId(userId) 回推 —— 任務可能在 owner 切到別的
    // 官方帳號之後才被消化，那時候「他現在選的 bot」已經是另一個了。
    const { userId, botId, lineUserId, addTags, removeTags, keyword } = message.body;

    logger.info('TAG_QUEUE', `處理標籤任務: ${keyword}`, { addTags, removeTags });

    if (!botId) {
        // 目前還沒有任何地方把任務丟進這個 queue（wrangler.jsonc 的 queue 綁定
        // 也還是註解掉的）。等有生產端時，它必須把 destination 一起放進
        // message.body —— 少了它只會寫到舊命名空間，而且不會有人發現。
        logger.warn('TAG_QUEUE', '任務缺少 botId，只能寫入舊命名空間', { userId, lineUserId });
    }

    try {
        const store = openBotStoreFor(env, userId, botId);
        let tagChanged = false;

        // 添加標籤
        if (addTags && addTags.length > 0) {
            await addTagsToEntity(store, 'member', lineUserId, addTags);
            logger.info('TAG_QUEUE', `已添加標籤: ${addTags.join(',')}`);
            tagChanged = true;
        }

        // 移除標籤
        if (removeTags && removeTags.length > 0) {
            await removeTagsFromEntity(store, 'member', lineUserId, removeTags);
            logger.info('TAG_QUEUE', `已移除標籤: ${removeTags.join(',')}`);
            tagChanged = true;
        }

        // 同步圖文選單
        if (tagChanged) {
            await syncMemberRichMenu(store, lineUserId);
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
