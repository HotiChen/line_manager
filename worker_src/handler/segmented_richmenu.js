/**
 * Segmented Rich Menu Handler
 * 處理分眾規則的 CRUD
 */
import { jsonResponse } from "../lib/utils.js";
import { openBotStore } from "../lib/bot_store.js";
import { validateRule } from "../lib/segmented_richmenu_logic.js";

export async function handleSaveSegmentedRules(request, env, ownerId) {
    try {
        const { rules } = await request.json();
        if (!Array.isArray(rules)) {
            return jsonResponse({ success: false, error: "Rules 必須是陣列" }, 400);
        }

        // LM-4R 格式：{ match: { tag } | { segment }, priority, richMenuId }；舊格式 {tag, richMenuId} 不再接受
        for (const [i, rule] of rules.entries()) {
            const problem = validateRule(rule);
            if (problem) {
                return jsonResponse({ success: false, error: `第 ${i + 1} 條規則：${problem}` }, 400);
            }
        }
        const clean = rules.map(r => ({
            match: r.match.tag !== undefined ? { tag: r.match.tag.trim() } : { segment: r.match.segment },
            priority: r.priority,
            richMenuId: r.richMenuId,
        }));

        const store = await openBotStore(env, ownerId);
        await store.put('segmentedRichMenuRules', clean);

        return jsonResponse({ success: true, rules: clean });
    } catch (error) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
}

export async function handleGetSegmentedRules(env, ownerId) {
    const store = await openBotStore(env, ownerId);
    const rules = await store.getOr('segmentedRichMenuRules', []);
    return jsonResponse({ success: true, rules });
}

export function route(request, env, ownerId, pathname) {
    if (pathname === "/richmenu/segmented/save" && request.method === "POST") {
        return handleSaveSegmentedRules(request, env, ownerId);
    }
    if (pathname === "/richmenu/segmented/list" && request.method === "GET") {
        return handleGetSegmentedRules(env, ownerId);
    }
    return null;
}
