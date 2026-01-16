export async function getAccessToken(env, userId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return null;

    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const info = accessTokens[project];

    if (!info) return null;
    return typeof info === "object" ? info.token : info;
}

export async function pushMessage(token, to, messages) {
    const url = "https://api.line.me/v2/bot/message/push";
    console.log(`📡 [LINE Push] Sending to ${to}...`);
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
    console.log(`📡 [LINE Push] Response:`, JSON.stringify(resJson));

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
