/**
 * Segmented Rich Menu Logic
 * 負責根據會員標籤自動切換圖文選單
 */
import { getAccessTokenForStore } from "./token_store.js";
import * as logger from "../utils/logger.js";
import { linkRichMenuToUser, unlinkRichMenuFromUser } from "./line_client.js";

/**
 * 同步特定會員的圖文選單
 */
export async function syncMemberRichMenu(store, memberId) {
    logger.info('SEGMENTED_RM', `同步會員選單: ${memberId}`);

    try {
        // 1. 取得會員 Tags
        const profile = await store.get('member', memberId);
        if (!profile) {
            logger.warn('SEGMENTED_RM', '找不到會員資料，無法進行選單同步');
            return;
        }
        const userTags = profile.tags || [];

        // 2. 取得分眾規則 
        // 規則格式: [ { "tag": "VIP", "richMenuId": "richmenu-xxx", "priority": 1 } ]
        const rules = await store.getOr('segmentedRichMenuRules', []);

        // 3. 尋找匹配的規則 (依優先級排序，數字愈小愈優先)
        const sortedRules = rules.sort((a, b) => (a.priority || 99) - (b.priority || 99));

        let targetRichMenuId = null;
        for (const rule of sortedRules) {
            if (userTags.includes(rule.tag)) {
                targetRichMenuId = rule.richMenuId;
                break;
            }
        }

        // 4. 取得 Access Token —— 必須是 store 所屬那個 bot 的。
        // 這裡走的是 webhook 路徑：store.botId 是事件的 destination，而
        // owner 此刻在後台可能選著另一個帳號。用「當前選定」的 token 會把
        // 選單掛到錯的官方帳號上去。
        const token = await getAccessTokenForStore(store);
        if (!token) {
            logger.error('SEGMENTED_RM', '找不到 Access Token');
            return;
        }

        // 5. 調用 LINE API 進行連結或解連
        if (targetRichMenuId) {
            logger.info('SEGMENTED_RM', `匹配到標籤選單: ${targetRichMenuId} (標籤: ${userTags.join(',')})`);
            await linkRichMenuToUser(memberId, targetRichMenuId, token);
        } else {
            logger.info('SEGMENTED_RM', `未匹配到特定標籤選單，解連個人選單 (回歸預設)`);
            await unlinkRichMenuFromUser(memberId, token);
        }

    } catch (error) {
        logger.error('SEGMENTED_RM', '同步過程發生錯誤', error);
    }
}

