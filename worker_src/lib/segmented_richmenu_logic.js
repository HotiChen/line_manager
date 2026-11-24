/**
 * Rich Menu 規則（LM-4R）：決定每位好友看到哪一個個人 Rich Menu
 *
 * 唯一的來源是 `segmentedRichMenuRules`：
 *   [{ match: { tag: "owner" },        priority: 1, richMenuId: "richmenu-…" },
 *    { match: { segment: "ip:vip" },   priority: 3, richMenuId: "richmenu-…" }]
 *
 * - tag：LM 的會員標籤
 * - segment：產品分眾 `<product_key>:<segment>`（4D 由產品寫入，草案 §D）
 * - priority 數字愈小愈優先；同分依清單順序
 * - 沒有符合任何規則 → 解除個人選單，回到 OA 預設選單
 *
 * 等級（tier）不再切換 Rich Menu；舊格式 `{tag, richMenuId}` 不再支援
 * （Tim 2026-11-24：舊設定直接廢掉）。
 *
 * 所有會改變結果的時機（標籤變更、分眾變更、加好友、綁定／解除綁定）
 * 都呼叫 syncMemberRichMenu。
 */
import { getAccessToken } from "./line_api.js";
import * as logger from "../utils/logger.js";
import { linkRichMenuToUser, unlinkRichMenuFromUser } from "./line_client.js";

const SEGMENT_RE = /^[a-z][a-z0-9]{1,15}:[a-z][a-z0-9_-]{0,31}$/;

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 檢查一條規則。合法回 null，否則回錯誤訊息。
 */
export function validateRule(rule) {
    if (!rule || typeof rule !== 'object') return '規則格式錯誤';
    const match = rule.match;
    if (!match || typeof match !== 'object') return '規則缺少 match';
    const hasTag = match.tag !== undefined;
    const hasSegment = match.segment !== undefined;
    if (hasTag === hasSegment) return 'match 必須只有 tag 或 segment 其中一個';
    if (hasTag && !nonEmptyString(match.tag)) return '標籤不可為空';
    if (hasSegment && !(typeof match.segment === 'string' && SEGMENT_RE.test(match.segment))) {
        return '分眾格式須為 <product_key>:<segment>，例如 ip:vip';
    }
    if (!nonEmptyString(rule.richMenuId)) return '規則缺少 richMenuId';
    if (!Number.isInteger(rule.priority) || rule.priority < 1) return 'priority 須為 1 以上的整數';
    return null;
}

/**
 * 依規則算出應顯示的 richMenuId（純函式）。
 * @param {Array} rules
 * @param {{tags?: string[], segments?: string[]}} who
 * @returns {string|null} null = 沒有符合，回到預設選單
 */
export function resolveRichMenuId(rules, { tags = [], segments = [] } = {}) {
    if (!Array.isArray(rules)) return null;
    const tagSet = new Set(tags);
    const segmentSet = new Set(segments);
    const winner = rules
        .map((rule, index) => ({ rule, index }))
        .filter(({ rule }) => validateRule(rule) === null)
        .filter(({ rule }) => (rule.match.tag !== undefined
            ? tagSet.has(rule.match.tag)
            : segmentSet.has(rule.match.segment)))
        .sort((a, b) => (a.rule.priority - b.rule.priority) || (a.index - b.index))[0];
    return winner ? winner.rule.richMenuId : null;
}

/**
 * 重新計算這位好友的 Rich Menu 並套用。
 *
 * 沒有設定任何規則時什麼都不做：這個 OA 沒在用分眾選單，不去動
 * 手動設定或 lm:menu 切換的個人選單。
 *
 * @param {import('./bot_store.js').BotStore} store
 * @param {string} memberId - LINE userId
 * @param {{accessToken?: string, segments?: string[]}} [opts]
 *   accessToken：webhook 有事件所屬 OA 的 token 時傳進來；沒有就用 owner 目前的 token。
 *   segments：產品分眾（4D 接上前為空）。
 */
export async function syncMemberRichMenu(store, memberId, { accessToken, segments = [] } = {}) {
    try {
        const rules = await store.getOr('segmentedRichMenuRules', []);
        if (!Array.isArray(rules) || rules.length === 0) return;

        const profile = await store.get('member', memberId);
        if (!profile) {
            logger.warn('SEGMENTED_RM', '找不到會員資料，無法進行選單同步');
            return;
        }

        const target = resolveRichMenuId(rules, { tags: profile.tags || [], segments });

        const token = accessToken || await getAccessToken(store.env, store.userId);
        if (!token) {
            logger.error('SEGMENTED_RM', '找不到 Access Token');
            return;
        }

        if (target) {
            await linkRichMenuToUser(memberId, target, token);
        } else {
            await unlinkRichMenuFromUser(memberId, token);
        }
    } catch (error) {
        logger.error('SEGMENTED_RM', `同步過程發生錯誤: ${error && error.message}`);
    }
}
