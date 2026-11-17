/**
 * 固定視窗限流（KV）以「整分鐘」為界：一個測試若在視窗邊界前後各打一部分請求，計數會被重置而偶發失敗
 * （CI 與高負載下曾發生）。這個 helper 把 Date.now 釘在當前這一分鐘的第 20 秒，跑完還原。
 */
export async function withPinnedWindow(fn) {
    const realNow = Date.now;
    const pinned = Math.floor(realNow() / 60000) * 60000 + 20000;
    Date.now = () => pinned;
    try {
        return await fn();
    } finally {
        Date.now = realNow;
    }
}
