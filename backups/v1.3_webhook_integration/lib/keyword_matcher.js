/**
 * 關鍵字匹配邏輯
 */
export function findMatchingKeyword(message, keywordList) {
    if (!message || !keywordList || !Array.isArray(keywordList)) {
        return null;
    }

    // 1. 精確匹配
    const exactMatch = keywordList.find(item => item.keyword === message);
    if (exactMatch) return exactMatch;

    // 2. 模糊匹配 (可根據需求擴展，例如包含、正則等)
    // 目前先只做精確匹配維持穩定性

    return null;
}
