/**
 * 通用 Tag 系統 - 混合設計
 * 
 * 特點：
 * 1. 實體內嵌入 tags（快速讀取）
 * 2. 中央索引（批次操作、統一管理）
 * 3. 支援任何實體類型（member, keyword, richmenu, message...）
 */

/**
 * addTagsToEntity
 * 為實體添加一個或多個 Tag，並同步反向索引與實體內部的嵌入式 Tag 列表
 * 
 * Pre-conditions:
 * - env: Cloudflare Worker 環境物件
 * - userId: 用戶識別碼
 * - entityType: 'member' | 'keyword' | 'richmenu' | 'message'
 * - entityId: 該實體的唯一 ID
 * - tags: 要添加的標籤陣列
 * 
 * Post-conditions:
 * - 若 Tag 不存在於全域列表，則自動建立
 * - 更新該 Tag 的實體 ID 索引列表
 * - 如果實體 Profile 存在，則更新其內部的 tags 欄位
 */
export async function addTagsToEntity(env, userId, entityType, entityId, tags) {
    if (!env || !userId || !entityType || !entityId || !Array.isArray(tags)) return;

    for (const tag of tags) {
        await ensureTagExists(env, userId, tag);

        // 更新反向索引
        const indexKey = `tag_${entityType}s_${userId}_${tag}`;
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");

        if (!entityList.includes(entityId)) {
            entityList.push(entityId);
            await env.KV_LINE_STORAGE.put(indexKey, JSON.stringify(entityList));
        }

        // 更新實體的 Tag 列表（嵌入式）
        const profileKey = getProfileKey(entityType, userId, entityId);
        const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

        if (profile && Object.keys(profile).length > 0) {
            profile.tags = profile.tags || [];
            if (!profile.tags.includes(tag)) {
                profile.tags.push(tag);
                await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
            }
        }
    }
}

/**
 * removeTagsFromEntity
 * 從實體中移除指定的 Tag
 * 
 * Post-conditions:
 * - 更新 Tag 的反向索引清單
 * - 從實體 Profile 的內嵌標籤列表中移除
 */
export async function removeTagsFromEntity(env, userId, entityType, entityId, tags) {
    if (!env || !userId || !entityType || !entityId || !Array.isArray(tags)) return;

    for (const tag of tags) {
        const indexKey = `tag_${entityType}s_${userId}_${tag}`;
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");
        const updated = entityList.filter(id => id !== entityId);
        await env.KV_LINE_STORAGE.put(indexKey, JSON.stringify(updated));

        const profileKey = getProfileKey(entityType, userId, entityId);
        const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

        if (profile?.tags) {
            profile.tags = profile.tags.filter(t => t !== tag);
            await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
        }
    }
}

/**
 * getEntitiesByTag
 * 根據標籤取得所有關聯的實體 ID
 */
export async function getEntitiesByTag(env, userId, entityType, tag) {
    if (!env || !userId || !entityType || !tag) return [];

    const indexKey = `tag_${entityType}s_${userId}_${tag}`;
    return JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");
}

/**
 * getEntityTags
 * 取得特定實體目前擁有的所有標籤
 */
export async function getEntityTags(env, userId, entityType, entityId) {
    if (!env || !userId || !entityType || !entityId) return [];

    const profileKey = getProfileKey(entityType, userId, entityId);
    const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");
    return profile.tags || [];
}

/**
 * batchAddTag
 * 批次將一個標籤套用到多個實體案
 */
export async function batchAddTag(env, userId, entityType, entityIds, tag) {
    await Promise.all(entityIds.map(id => addTagsToEntity(env, userId, entityType, id, [tag])));
}

/**
 * renameTag
 * 全域重命名標籤並更新所有關聯實源
 * 
 * Pre-conditions: oldTag 必須存在
 * Post-conditions: 所有標記為 oldTag 的實體都會更新為 newTag，舊索引將刪除
 */
export async function renameTag(env, userId, oldTag, newTag) {
    if (!env || !userId || !oldTag || !newTag) return;

    const entityTypes = ['member', 'keyword', 'richmenu', 'message'];

    for (const type of entityTypes) {
        const oldKey = `tag_${type}s_${userId}_${oldTag}`;
        const newKey = `tag_${type}s_${userId}_${newTag}`;

        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(oldKey) || "[]");
        if (entityList.length === 0) continue;

        await env.KV_LINE_STORAGE.put(newKey, JSON.stringify(entityList));

        await Promise.all(entityList.map(async entityId => {
            const profileKey = getProfileKey(type, userId, entityId);
            const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

            if (profile.tags) {
                profile.tags = profile.tags.map(t => t === oldTag ? newTag : t);
                await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
            }
        }));

        await env.KV_LINE_STORAGE.delete(oldKey);
    }

    const tagListKey = `tag_list_${userId}`;
    const tagList = JSON.parse(await env.KV_LINE_STORAGE.get(tagListKey) || "[]");
    const updatedList = tagList.map(t => t === oldTag ? newTag : t);
    await env.KV_LINE_STORAGE.put(tagListKey, JSON.stringify(updatedList));
}

/**
 * deleteTag
 * 從系統中永久刪除某個標籤
 */
export async function deleteTag(env, userId, tag) {
    const entityTypes = ['member', 'keyword', 'richmenu', 'message'];

    for (const type of entityTypes) {
        const indexKey = `tag_${type}s_${userId}_${tag}`;
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");

        await Promise.all(entityList.map(id => removeTagsFromEntity(env, userId, type, id, [tag])));
        await env.KV_LINE_STORAGE.delete(indexKey);
    }

    const tagListKey = `tag_list_${userId}`;
    const tagList = JSON.parse(await env.KV_LINE_STORAGE.get(tagListKey) || "[]");
    const updatedList = tagList.filter(t => t !== tag);
    await env.KV_LINE_STORAGE.put(tagListKey, JSON.stringify(updatedList));
}

/**
 * getTagStats
 * 取得標籤的使用統計（各類型實體數量）
 */
export async function getTagStats(env, userId, tag) {
    const entityTypes = ['member', 'keyword', 'richmenu', 'message'];
    const stats = {};

    for (const type of entityTypes) {
        const indexKey = `tag_${type}s_${userId}_${tag}`;
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");
        stats[type] = entityList.length;
    }

    return stats;
}

/**
 * getAllTagsWithStats
 * 取得所有標籤及其統計數據
 */
export async function getAllTagsWithStats(env, userId) {
    const tagListKey = `tag_list_${userId}`;
    const tagList = JSON.parse(await env.KV_LINE_STORAGE.get(tagListKey) || "[]");

    const tagsWithStats = await Promise.all(tagList.map(async tag => {
        const stats = await getTagStats(env, userId, tag);
        const total = Object.values(stats).reduce((sum, count) => sum + count, 0);
        return { name: tag, total, stats };
    }));

    return tagsWithStats;
}

/**
 * ensureTagExists
 * 輔助函數：確保標籤存在於全域列表中
 */
export async function ensureTagExists(env, userId, tag) {
    const tagListKey = `tag_list_${userId}`;
    const tagList = JSON.parse(await env.KV_LINE_STORAGE.get(tagListKey) || "[]");

    if (!tagList.includes(tag)) {
        tagList.push(tag);
        await env.KV_LINE_STORAGE.put(tagListKey, JSON.stringify(tagList));
    }
}

/**
 * getProfileKey
 * 輔助函數：取得對應實體類型的 KV Key
 */
function getProfileKey(entityType, userId, entityId) {
    const keyMap = {
        'member': `member_profile_${userId}_${entityId}`,
        'keyword': `keyword_${userId}_${entityId}`,
        'richmenu': `richmenu_meta_${userId}_${entityId}`,
        'message': `message_${userId}_${entityId}`
    };
    return keyMap[entityType] || `${entityType}_${userId}_${entityId}`;
}
