/**
 * Postback Data 編碼/解碼規範
 * 
 * 用於統一處理 Rich Menu、Flex Message、Quick Reply 等的 postback data
 * 支援將 autoTags 等 metadata 嵌入到 data 欄位中
 * 
 * @version 1.0.0
 */

/**
 * Postback Data 格式規範
 * 
 * 格式 1（舊格式 - 向後兼容）：
 *   純字串: "action=buy_product&id=123"
 * 
 * 格式 2（新格式 - 包含 metadata）：
 *   JSON 字串: {
 *     "v": 1,                    // 版本號
 *     "d": "action=buy_product", // 原始業務資料 (data)
 *     "m": {                     // metadata
 *       "autoTags": {
 *         "add": ["VIP"],
 *         "remove": ["trial"]
 *       }
 *     }
 *   }
 */

const POSTBACK_VERSION = 1;

/**
 * 編碼：將業務資料和 metadata 合併為 postback data
 * 
 * @param {string} businessData - 原始業務資料（例如："action=buy_product"）
 * @param {Object} metadata - metadata 物件
 * @param {Object} metadata.autoTags - 自動標籤設定 { add: [], remove: [] }
 * @returns {string} 編碼後的 postback data
 * 
 * Pre-conditions:
 * - businessData 需為字串
 * Post-conditions:
 * - 回傳字串，若含 metadata 則格式為 JSON
 * 
 * @example
 * encodePostbackData("action=test", { autoTags: { add: ["VIP"], remove: [] } })
 * // 返回: '{"v":1,"d":"action=test","m":{"autoTags":{"add":["VIP"],"remove":[]}}}'
 */
export function encodePostbackData(businessData, metadata = {}) {
    // 如果沒有 metadata，直接返回原始資料（向後兼容）
    if (!metadata || Object.keys(metadata).length === 0) {
        return businessData;
    }

    // 如果有 metadata，編碼為 JSON
    const encoded = {
        v: POSTBACK_VERSION,
        d: businessData,
        m: metadata
    };

    return JSON.stringify(encoded);
}

/**
 * 解碼：從 postback data 中提取業務資料和 metadata
 * 
 * @param {string} postbackData - postback data 字串
 * @returns {Object} { data: string, metadata: Object }
 * 
 * Pre-conditions:
 * - postbackData 為字串或空
 * Post-conditions:
 * - 必定回傳包含 data 與 metadata 的物件，即使解析失敗亦同
 * 
 * @example
 * // 格式 1（舊格式）
 * decodePostbackData("action=test")
 * // 返回: { data: "action=test", metadata: {} }
 * 
 * // 格式 2（新格式）
 * decodePostbackData('{"v":1,"d":"action=test","m":{"autoTags":{"add":["VIP"]}}}')
 * // 返回: { 
 * //   data: "action=test", 
 * //   metadata: { autoTags: { add: ["VIP"], remove: [] } } 
 * // }
 */
export function decodePostbackData(postbackData) {
    if (!postbackData || typeof postbackData !== 'string') {
        return { data: '', metadata: {} };
    }

    // 嘗試解析為 JSON
    try {
        const parsed = JSON.parse(postbackData);

        // 檢查是否為新格式（包含版本號）
        if (parsed.v === POSTBACK_VERSION && 'd' in parsed) {
            return {
                data: parsed.d || '',
                metadata: parsed.m || {}
            };
        }

        // 如果能解析為 JSON 但格式不對，視為舊格式
        return { data: postbackData, metadata: {} };

    } catch (e) {
        // 無法解析為 JSON，視為舊格式（純字串）
        return { data: postbackData, metadata: {} };
    }
}

/**
 * 從 action 物件建立 postback data
 * 
 * @param {Object} action - action 物件
 * @param {string} action.data - 業務資料
 * @param {Object} action.autoTags - 可選的 autoTags
 * @returns {string} 編碼後的 postback data
 * 
 * Pre-conditions:
 * - action 需具備 data 屬性
 * Post-conditions:
 * - 成功將 action.autoTags 等 meta 打包成 postback 字串
 */
export function createPostbackDataFromAction(action) {
    if (!action || !action.data) {
        return '';
    }

    const metadata = {};

    // 提取 autoTags
    if (action.autoTags && (action.autoTags.add?.length > 0 || action.autoTags.remove?.length > 0)) {
        metadata.autoTags = action.autoTags;
    }

    return encodePostbackData(action.data, metadata);
}

/**
 * 驗證 postback data 格式
 * 
 * @param {string} postbackData - postback data 字串
 * @returns {Object} { valid: boolean, error: string }
 * 
 * Pre-conditions:
 * - postbackData 不得為空
 * Post-conditions:
 * - 回傳 valid 布林值與對應 error 訊息
 */
export function validatePostbackData(postbackData) {
    if (!postbackData) {
        return { valid: false, error: 'Postback data is empty' };
    }

    const decoded = decodePostbackData(postbackData);

    if (!decoded.data) {
        return { valid: false, error: 'Business data is missing' };
    }

    return { valid: true, error: null };
}

/**
 * 取得 postback data 的簡短顯示文字（用於 UI）
 * 
 * @param {string} postbackData - postback data 字串
 * @param {number} maxLength - 最大長度（預設 50）
 * @returns {string} 簡短文字
 * 
 * Pre-conditions:
 * - postbackData 必須能被 decodePostbackData 解析
 * Post-conditions:
 * - 回傳附帶標籤狀態的 UI 展示文字
 */
export function getPostbackDisplayText(postbackData, maxLength = 50) {
    const { data, metadata } = decodePostbackData(postbackData);

    let displayText = data;

    // 添加 metadata 標記
    const tags = [];
    if (metadata.autoTags?.add?.length > 0) {
        tags.push(`+${metadata.autoTags.add.length}標籤`);
    }
    if (metadata.autoTags?.remove?.length > 0) {
        tags.push(`-${metadata.autoTags.remove.length}標籤`);
    }

    if (tags.length > 0) {
        displayText += ` (${tags.join(', ')})`;
    }

    // 截斷過長文字
    if (displayText.length > maxLength) {
        return displayText.substring(0, maxLength - 3) + '...';
    }

    return displayText;
}
