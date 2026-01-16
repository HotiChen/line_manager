// worker_src/handler/quick_reply.js

import { jsonResponse } from '../lib/utils.js';

/**
 * 儲存 Quick Reply 模板
 */
async function handleSaveQuickReply(request, env, userId) {
    const data = await request.json();
    const { id, name, items } = data;

    if (!name || !Array.isArray(items)) {
        return jsonResponse({ success: false, error: '缺少 name 或 items' }, 400);
    }

    const listKey = `quick_reply_list_${userId}`;
    const existing = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || '[]');

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
        console.log('🔄 [QR Save] 更新:', qrItem.id);
    } else {
        existing.push(qrItem);
        console.log('➕ [QR Save] 新增:', qrItem.id);
    }

    await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(existing));
    return jsonResponse({ success: true, data: qrItem });
}

/**
 * 列出所有 Quick Reply 模板
 */
async function handleListQuickReplies(env, userId) {
    const listKey = `quick_reply_list_${userId}`;
    const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || '[]');
    console.log('📋 [QR List] 共', list.length, '筆');
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

    const listKey = `quick_reply_list_${userId}`;
    const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || '[]');
    const updated = list.filter(item => !toDelete.includes(item.id));

    await env.KV_LINE_STORAGE.put(listKey, JSON.stringify(updated));
    console.log('🗑️ [QR Delete] 已刪除:', toDelete);
    return jsonResponse({ success: true, deleted: toDelete });
}

/**
 * 取得單一 Quick Reply 模板
 */
async function handleGetQuickReply(env, userId, qrId) {
    const listKey = `quick_reply_list_${userId}`;
    const list = JSON.parse(await env.KV_LINE_STORAGE.get(listKey) || '[]');
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
    console.log('📡 [QR Route] 處理路由：', pathname);

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
