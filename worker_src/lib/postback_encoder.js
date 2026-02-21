/**
 * Postback Data 編碼/解碼規範（Worker/Node.js 版本）
 * 
 * 這是 helper/postback-encoder.js 的 CommonJS 版本，用於 Worker 環境
 * 
 * @version 1.0.0
 */

const POSTBACK_VERSION = 1;

/**
 * 編碼：將業務資料和 metadata 合併為 postback data
 */
function encodePostbackData(businessData, metadata = {}) {
    if (!metadata || Object.keys(metadata).length === 0) {
        return businessData;
    }

    const encoded = {
        v: POSTBACK_VERSION,
        d: businessData,
        m: metadata
    };

    return JSON.stringify(encoded);
}

/**
 * 解碼：從 postback data 中提取業務資料和 metadata
 */
function decodePostbackData(postbackData) {
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

export { encodePostbackData, decodePostbackData, POSTBACK_VERSION };
