import { getCurrentAccessToken } from "./token_store.js";

/**
 * 當前專案的 access token。
 *
 * 實作在 lib/token_store.js —— 讀寫一律走那裡，因為 token 現在是加密存放，
 * 解密邏輯不可散落（見該檔案開頭的說明）。
 */
export async function getAccessToken(env, userId) {
    return getCurrentAccessToken(env, userId);
}

export async function pushMessage(token, to, messages) {
    const url = "https://api.line.me/v2/bot/message/push";
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
            to,
            messages
        })
    });

    const resJson = await response.json();

    if (!response.ok) {
        console.error(`[LINE API] Push failed: ${response.status}`, resJson);
        throw new Error(`LINE API Push failed: ${JSON.stringify(resJson)}`);
    }

    return resJson;
}

export async function broadcastMessage(token, messages) {
    const url = "https://api.line.me/v2/bot/message/broadcast";
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
            messages
        })
    });

    if (!response.ok) {
        const errBody = await response.text();
        console.error(`[LINE API] Broadcast failed: ${response.status} ${errBody}`);
        throw new Error(`LINE API Broadcast failed: ${errBody}`);
    }

    return await response.json();
}
