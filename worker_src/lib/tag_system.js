/**
 * 通用 Tag 系統 - 混合設計
 *
 * 特點：
 * 1. 實體內嵌入 tags（快速讀取）
 * 2. 中央索引（批次操作、統一管理）
 * 3. 支援任何實體類型（member, keyword, richmenu, message...）
 *
 * ## 為什麼收 BotStore 而不是 (env, userId)
 *
 * 標籤是 per-bot 的資料。botId 只有呼叫端知道 —— 後台看的是使用者在
 * 介面上選的 bot，webhook 看的是 LINE 的 destination，兩者可能不同。
 * 在這一層自己去 resolveBotId 等於讓「把標籤寫到另一個官方帳號」
 * 變成一個不會報錯的 bug。
 *
 * 簽章從 (env, userId, …) 改成 (store, …) 也是刻意的：忘記改的呼叫端
 * 會在第一次執行時就丟 `store.get is not a function`，而不是安靜地
 * 用 env 當 userId 去拼出一個誰都讀不到的 key。
 */

/**
 * entityType → bot_store 的資源名稱。
 *
 * 這四種型別是 renameTag / deleteTag 會掃過的全部範圍。未知型別回 null，
 * 由呼叫處決定要不要跳過 —— 舊版會拼出 `${entityType}_${userId}_${id}`
 * 這種沒有人寫入過的 key，看起來成功但永遠是空的。
 */
const ENTITY_RESOURCE = {
    member: 'member',
    keyword: 'keyword',
    richmenu: 'richMenuMeta',
    message: 'message',
};

/** renameTag / deleteTag / getTagStats 會掃過的實體型別 */
const ENTITY_TYPES = Object.keys(ENTITY_RESOURCE);

/**
 * 讀取某個實體的 profile（標籤內嵌在裡面）。
 *
 * @returns {Promise<Object|null>} 未知型別或讀不到時回 null
 */
async function readEntityProfile(store, entityType, entityId) {
    const resource = ENTITY_RESOURCE[entityType];
    if (!resource) {
        console.warn(`[tag_system] 未知的 entityType '${entityType}'，跳過內嵌標籤更新`);
        return null;
    }
    return store.get(resource, entityId);
}

async function writeEntityProfile(store, entityType, entityId, profile) {
    const resource = ENTITY_RESOURCE[entityType];
    if (!resource) return;
    await store.put(resource, profile, entityId);
}

/**
 * addTagsToEntity
 * 為實體添加一個或多個 Tag，並同步反向索引與實體內部的嵌入式 Tag 列表
 *
 * Pre-conditions:
 * - store: BotStore（見 lib/bot_store.js）
 * - entityType: 'member' | 'keyword' | 'richmenu' | 'message'
 * - entityId: 該實體的唯一 ID
 * - tags: 要添加的標籤陣列
 *
 * Post-conditions:
 * - 若 Tag 不存在於全域列表，則自動建立
 * - 更新該 Tag 的實體 ID 索引列表
 * - 如果實體 Profile 存在，則更新其內部的 tags 欄位
 */
export async function addTagsToEntity(store, entityType, entityId, tags) {
    if (!store || !entityType || !entityId || !Array.isArray(tags)) return;

    for (const tag of tags) {
        await ensureTagExists(store, tag);

        // 更新反向索引
        const entityList = await store.getOr('tagEntities', [], entityType, tag);

        if (!entityList.includes(entityId)) {
            entityList.push(entityId);
            await store.put('tagEntities', entityList, entityType, tag);
        }

        // 更新實體的 Tag 列表（嵌入式）
        const profile = await readEntityProfile(store, entityType, entityId);

        if (profile && Object.keys(profile).length > 0) {
            profile.tags = profile.tags || [];
            if (!profile.tags.includes(tag)) {
                profile.tags.push(tag);
                await writeEntityProfile(store, entityType, entityId, profile);
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
export async function removeTagsFromEntity(store, entityType, entityId, tags) {
    if (!store || !entityType || !entityId || !Array.isArray(tags)) return;

    for (const tag of tags) {
        const entityList = await store.getOr('tagEntities', [], entityType, tag);
        const updated = entityList.filter(id => id !== entityId);
        await store.put('tagEntities', updated, entityType, tag);

        const profile = await readEntityProfile(store, entityType, entityId);

        if (profile?.tags) {
            profile.tags = profile.tags.filter(t => t !== tag);
            await writeEntityProfile(store, entityType, entityId, profile);
        }
    }
}

/**
 * getEntitiesByTag
 * 根據標籤取得所有關聯的實體 ID
 */
export async function getEntitiesByTag(store, entityType, tag) {
    if (!store || !entityType || !tag) return [];
    return store.getOr('tagEntities', [], entityType, tag);
}

/**
 * getEntityTags
 * 取得特定實體目前擁有的所有標籤
 */
export async function getEntityTags(store, entityType, entityId) {
    if (!store || !entityType || !entityId) return [];

    const profile = await readEntityProfile(store, entityType, entityId);
    return profile?.tags || [];
}

/**
 * batchAddTag
 * 批次將一個標籤套用到多個實體
 */
export async function batchAddTag(store, entityType, entityIds, tag) {
    await Promise.all(entityIds.map(id => addTagsToEntity(store, entityType, id, [tag])));
}

/**
 * renameTag
 * 全域重命名標籤並更新所有關聯實體
 *
 * Pre-conditions: oldTag 必須存在
 * Post-conditions: 所有標記為 oldTag 的實體都會更新為 newTag，舊索引將刪除
 */
export async function renameTag(store, oldTag, newTag) {
    if (!store || !oldTag || !newTag) return;

    for (const type of ENTITY_TYPES) {
        const entityList = await store.getOr('tagEntities', [], type, oldTag);
        if (entityList.length === 0) continue;

        await store.put('tagEntities', entityList, type, newTag);

        await Promise.all(entityList.map(async entityId => {
            const profile = await readEntityProfile(store, type, entityId);

            if (profile?.tags) {
                profile.tags = profile.tags.map(t => t === oldTag ? newTag : t);
                await writeEntityProfile(store, type, entityId, profile);
            }
        }));

        await store.del('tagEntities', type, oldTag);
    }

    const tagList = await store.getOr('tags', []);
    const updatedList = tagList.map(t => t === oldTag ? newTag : t);
    await store.put('tags', updatedList);
}

/**
 * deleteTag
 * 從系統中永久刪除某個標籤
 */
export async function deleteTag(store, tag) {
    for (const type of ENTITY_TYPES) {
        const entityList = await store.getOr('tagEntities', [], type, tag);

        await Promise.all(entityList.map(id => removeTagsFromEntity(store, type, id, [tag])));
        await store.del('tagEntities', type, tag);
    }

    const tagList = await store.getOr('tags', []);
    const updatedList = tagList.filter(t => t !== tag);
    await store.put('tags', updatedList);
}

/**
 * getTagStats
 * 取得標籤的使用統計（各類型實體數量）
 */
export async function getTagStats(store, tag) {
    const stats = {};

    for (const type of ENTITY_TYPES) {
        const entityList = await store.getOr('tagEntities', [], type, tag);
        stats[type] = entityList.length;
    }

    return stats;
}

/**
 * getAllTagsWithStats
 * 取得所有標籤及其統計數據
 */
export async function getAllTagsWithStats(store) {
    const tagList = await store.getOr('tags', []);

    const tagsWithStats = await Promise.all(tagList.map(async tag => {
        const stats = await getTagStats(store, tag);
        const total = Object.values(stats).reduce((sum, count) => sum + count, 0);
        return { name: tag, total, stats };
    }));

    return tagsWithStats;
}

/**
 * ensureTagExists
 * 輔助函數：確保標籤存在於全域列表中
 */
export async function ensureTagExists(store, tag) {
    const tagList = await store.getOr('tags', []);

    if (!tagList.includes(tag)) {
        tagList.push(tag);
        await store.put('tags', tagList);
    }
}
