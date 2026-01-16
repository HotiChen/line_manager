/**
 * 通用 Tag 系統 - 混合設計
 * 
 * 特點：
 * 1. 實體內嵌入 tags（快速讀取）
 * 2. 中央索引（批次操作、統一管理）
 * 3. 支援任何實體類型（member, keyword, richmenu, message...）
 */

/**
 * 為實體添加 Tag
 * @param {Object} env - KV 環境
 * @param {string} userId - 用戶 ID
 * @param {string} entityType - 實體類型: member, keyword, richmenu, message
 * @param {string} entityId - 實體 ID
 * @param {string[]} tags - 要添加的 Tags
 */
export async function addTagsToEntity(env, userId, entityType, entityId, tags) {
    console.log(`[Tag] 開始為 ${entityType}:${entityId} 添加標籤:`, tags);

    for (const tag of tags) {
        // 1. 確保 Tag 存在於 Tag 列表
        await ensureTagExists(env, userId, tag);

        // 2. 更新 Tag 的反向索引
        const indexKey = `tag_${entityType}s_${userId}_${tag}`;
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");

        if (!entityList.includes(entityId)) {
            entityList.push(entityId);
            await env.KV_LINE_STORAGE.put(indexKey, JSON.stringify(entityList));
        }

        // 3. 更新實體的 Tag 列表（嵌入式）
        const profileKey = getProfileKey(entityType, userId, entityId);
        const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

        if (profile && Object.keys(profile).length > 0) {
            profile.tags = profile.tags || [];
            if (!profile.tags.includes(tag)) {
                profile.tags.push(tag);
            }
            await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
        }
    }

    console.log(`✅ [Tag] 已為 ${entityType}:${entityId} 添加 tags:`, tags);
}

/**
 * 從實體移除 Tag
 */
export async function removeTagsFromEntity(env, userId, entityType, entityId, tags) {
    for (const tag of tags) {
        // 1. 更新反向索引
        const indexKey = `tag_${entityType}s_${userId}_${tag}`;
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");
        const updated = entityList.filter(id => id !== entityId);
        await env.KV_LINE_STORAGE.put(indexKey, JSON.stringify(updated));

        // 2. 更新實體的 Tag 列表
        const profileKey = getProfileKey(entityType, userId, entityId);
        const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

        if (profile && profile.tags) {
            profile.tags = profile.tags.filter(t => t !== tag);
            await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
        }
    }

    console.log(`🗑️ [Tag] 已從 ${entityType}:${entityId} 移除 tags:`, tags);
}

/**
 * 取得有特定 Tag 的所有實體
 */
export async function getEntitiesByTag(env, userId, entityType, tag) {
    const indexKey = `tag_${entityType}s_${userId}_${tag}`;
    const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");
    return entityList;
}

/**
 * 取得實體的所有 Tags
 */
export async function getEntityTags(env, userId, entityType, entityId) {
    const profileKey = getProfileKey(entityType, userId, entityId);
    const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");
    return profile.tags || [];
}

/**
 * 批次為多個實體添加 Tag
 */
export async function batchAddTag(env, userId, entityType, entityIds, tag) {
    for (const entityId of entityIds) {
        await addTagsToEntity(env, userId, entityType, entityId, [tag]);
    }
    console.log(`✅ [Tag] 批次為 ${entityIds.length} 個 ${entityType} 添加 tag: ${tag}`);
}

/**
 * 重命名 Tag（影響所有使用該 Tag 的實體）
 */
export async function renameTag(env, userId, oldTag, newTag) {
    const entityTypes = ['member', 'keyword', 'richmenu', 'message'];

    for (const type of entityTypes) {
        const oldKey = `tag_${type}s_${userId}_${oldTag}`;
        const newKey = `tag_${type}s_${userId}_${newTag}`;

        // 複製舊索引到新索引
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(oldKey) || "[]");
        if (entityList.length > 0) {
            await env.KV_LINE_STORAGE.put(newKey, JSON.stringify(entityList));

            // 更新每個實體的 tags
            for (const entityId of entityList) {
                const profileKey = getProfileKey(type, userId, entityId);
                const profile = JSON.parse(await env.KV_LINE_STORAGE.get(profileKey) || "{}");

                if (profile.tags) {
                    profile.tags = profile.tags.map(t => t === oldTag ? newTag : t);
                    await env.KV_LINE_STORAGE.put(profileKey, JSON.stringify(profile));
                }
            }

            // 刪除舊索引
            await env.KV_LINE_STORAGE.delete(oldKey);
        }
    }

    // 更新 Tag 列表
    const tagListKey = `tag_list_${userId}`;
    const tagList = JSON.parse(await env.KV_LINE_STORAGE.get(tagListKey) || "[]");
    const updatedList = tagList.map(t => t === oldTag ? newTag : t);
    await env.KV_LINE_STORAGE.put(tagListKey, JSON.stringify(updatedList));

    console.log(`📝 [Tag] 已重命名: ${oldTag} → ${newTag}`);
}

/**
 * 刪除 Tag（從所有實體移除）
 */
export async function deleteTag(env, userId, tag) {
    const entityTypes = ['member', 'keyword', 'richmenu', 'message'];

    for (const type of entityTypes) {
        const indexKey = `tag_${type}s_${userId}_${tag}`;
        const entityList = JSON.parse(await env.KV_LINE_STORAGE.get(indexKey) || "[]");

        // 從每個實體移除此 Tag
        for (const entityId of entityList) {
            await removeTagsFromEntity(env, userId, type, entityId, [tag]);
        }

        // 刪除索引
        await env.KV_LINE_STORAGE.delete(indexKey);
    }

    // 從 Tag 列表移除
    const tagListKey = `tag_list_${userId}`;
    const tagList = JSON.parse(await env.KV_LINE_STORAGE.get(tagListKey) || "[]");
    const updatedList = tagList.filter(t => t !== tag);
    await env.KV_LINE_STORAGE.put(tagListKey, JSON.stringify(updatedList));

    console.log(`🗑️ [Tag] 已刪除: ${tag}`);
}

/**
 * 取得 Tag 使用統計
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
 * 取得所有 Tag 及其使用統計
 */
export async function getAllTagsWithStats(env, userId) {
    const tagListKey = `tag_list_${userId}`;
    const tagList = JSON.parse(await env.KV_LINE_STORAGE.get(tagListKey) || "[]");

    const tagsWithStats = [];
    for (const tag of tagList) {
        const stats = await getTagStats(env, userId, tag);
        const total = Object.values(stats).reduce((sum, count) => sum + count, 0);
        tagsWithStats.push({
            name: tag,
            total,
            stats
        });
    }

    return tagsWithStats;
}

/**
 * 輔助函數：確保 Tag 存在
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
 * 輔助函數：取得 Profile Key
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
