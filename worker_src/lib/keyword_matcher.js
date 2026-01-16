/**
 * 關鍵字匹配邏輯
 */
export function findMatchingKeyword(message, keywordList) {
    if (!message || !keywordList || !Array.isArray(keywordList)) {
        return null;
    }

    const trimmedMsg = message.trim();
    if (!trimmedMsg) return null;

    // 支援逗號分隔的多個關鍵字，且均為不區分大小寫
    for (const item of keywordList) {
        if (!item.keyword) continue;

        // 分割可能存在的逗號
        const keywords = item.keyword.split(/[,，]/);

        for (let kw of keywords) {
            kw = kw.trim();
            if (!kw) continue;

            // 1. 精確匹配 (不區分大小寫)
            if (kw.toLowerCase() === trimmedMsg.toLowerCase()) {
                return item;
            }
        }
    }

    // 2. 模糊匹配 (未來可選)
    return null;
}
