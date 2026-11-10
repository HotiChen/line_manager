// worker_src/handler/quick_reply.js

import { jsonResponse } from '../lib/utils.js';
import { openBotStore } from '../lib/bot_store.js';

/**
 * 儲存 Quick Reply 模板
 */
async function handleSaveQuickReply(request, env, userId) {
    const data = await request.json();
    const { id, name, items } = data;

    if (!name || !Array.isArray(items)) {
        return jsonResponse({ success: false, error: '缺少 name 或 items' }, 400);
    }

    const store = await openBotStore(env, userId);
    const existing = await store.getOr('quickReplies', []);

    const qrItem = {
        id: id || `qr_${Date.now()}`,
        name,
        items,
        createdAt: data.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    const index = existing.findIndex(item => item.id === qrItem.id);
    if (index >= 0) {
        existing[index] = qrItem;
    } else {
        existing.push(qrItem);
    }

    await store.put('quickReplies', existing);
    return jsonResponse({ success: true, data: qrItem });
}

/**
 * 列出所有 Quick Reply 模板
 */
async function handleListQuickReplies(env, userId) {
    const store = await openBotStore(env, userId);
    const list = await store.getOr('quickReplies', []);
    return jsonResponse({ success: true, data: list });
}

/**
 * 刪除 Quick Reply 模板
 */
async function handleDeleteQuickReply(request, env, userId) {
    const { id, ids } = await request.json();

    const toDelete = [];
    if (id) toDelete.push(id);
    if (Array.isArray(ids)) toDelete.push(...ids);

    if (toDelete.length === 0) {
        return jsonResponse({ success: false, error: '缺少 id 或 ids' }, 400);
    }

    const store = await openBotStore(env, userId);
    const list = await store.getOr('quickReplies', []);
    const updated = list.filter(item => !toDelete.includes(item.id));

    await store.put('quickReplies', updated);
    return jsonResponse({ success: true, deleted: toDelete });
}

/**
 * 取得單一 Quick Reply 模板
 */
async function handleGetQuickReply(env, userId, qrId) {
    const store = await openBotStore(env, userId);
    const list = await store.getOr('quickReplies', []);
    const item = list.find(qr => qr.id === qrId);

    if (!item) {
        return jsonResponse({ success: false, error: 'Quick Reply 不存在' }, 404);
    }

    return jsonResponse({ success: true, data: item });
}

/**
 * QR 路由處理
 */
export function route(request, env, userId, pathname) {

    if (pathname === '/quickreply/save' && request.method === 'POST') {
        return handleSaveQuickReply(request, env, userId);
    }
    if (pathname === '/quickreply/list' && request.method === 'GET') {
        return handleListQuickReplies(env, userId);
    }
    if (pathname === '/quickreply/delete' && request.method === 'POST') {
        return handleDeleteQuickReply(request, env, userId);
    }

    // GET /quickreply/:id
    const getMatch = pathname.match(/^\/quickreply\/([^/]+)$/);
    if (getMatch && request.method === 'GET') {
        return handleGetQuickReply(env, userId, getMatch[1]);
    }

    return jsonResponse({ success: false, error: 'Invalid quickreply route' }, 404);
}
