/**
 * KV Schema — 所有 KV key 的唯一產生處
 *
 * 命名空間只有三種：
 *
 *   bot:${botId}:<resource>      一個 LINE 官方帳號的全部資料（隔離邊界）
 *   user:${userId}:<resource>    關於「人」的資料（他有哪些 bot、他自己的 profile、rate limit）
 *   invite:${token}              全域的邀請 token
 *
 * botId 是 LINE 的 destination —— 不是發明出來的 id。token.js 註冊 access token
 * 時會打 /v2/bot/info 取得它，webhook.js 已經用它路由進來的事件。所以它是這個
 * 系統裡唯一既穩定、又能唯一識別一個官方帳號的東西。
 *
 * 為什麼用冒號而不是底線：舊的 `<domain>_${userId}` 無法列出「某個 bot 的全部
 * 資料」，而多租戶必須能匯出或刪除單一租戶。`list({ prefix: BotKeys.prefix(id) })`
 * 就是為此存在。
 *
 * 代價是分隔符進了 key，所以每個組件都必須驗證：botId 或 tag 名稱裡夾一個
 * ':' 就能寫到別人的命名空間。assertComponent 是這件事的唯一防線，不可繞過。
 * 注意它刻意不限制格式（正式環境已有 botId 為 'testbot' 的資料），只禁止
 * 分隔符與空值。
 */

export const KV_PREFIX = {
    BOT: 'bot',
    USER: 'user',
    INVITE: 'invite',
    LEGACY: 'legacy',
};

/** key 裡的分隔符。組件含有它就能跨出自己的命名空間。 */
const SEPARATOR = ':';

/**
 * 驗證一個 key 組件。
 *
 * @param {unknown} value
 * @param {string} name - 參數名，只用在錯誤訊息
 * @returns {string}
 * @throws {TypeError} 空值、非字串、或含有分隔符
 */
function assertComponent(value, name) {
    if (typeof value !== 'string' || value === '') {
        throw new TypeError(`invalid key component: ${name} must be a non-empty string`);
    }
    if (value.includes(SEPARATOR)) {
        throw new TypeError(`invalid key component: ${name} must not contain '${SEPARATOR}'`);
    }
    return value;
}

/** bot:${botId}:<rest> */
function botKey(botId, ...rest) {
    assertComponent(botId, 'botId');
    const parts = rest.map((p, i) => assertComponent(p, `id[${i}]`));
    return [KV_PREFIX.BOT, botId, ...parts].join(SEPARATOR);
}

/** user:${userId}:<rest> */
function userKey(userId, ...rest) {
    assertComponent(userId, 'userId');
    const parts = rest.map((p, i) => assertComponent(p, `id[${i}]`));
    return [KV_PREFIX.USER, userId, ...parts].join(SEPARATOR);
}

/**
 * 一個 bot 的全部資料，都在這底下。
 *
 * 每個 getter 只有一行，因為這個模組的價值在「唯一出處」，不在邏輯。
 * 新增資源時加在這裡，不要在 handler 裡拼字串。
 */
export const BotKeys = {
    /** 列出這個 bot 的所有 key 用的前綴（匯出／刪除租戶） */
    prefix: (botId) => `${botKey(botId, 'x').slice(0, -1)}`,

    // ── bot 本身 ──
    info: (botId) => botKey(botId, 'info'),
    owner: (botId) => botKey(botId, 'owner'),
    permissions: (botId) => botKey(botId, 'permissions'),
    /** LINE channel access token 與 displayName（內容需加密，見 ARCHITECTURE_PLATFORM.md 第十節） */
    credential: (botId) => botKey(botId, 'credential'),

    // ── 會員（CRM）──
    members: (botId) => botKey(botId, 'members'),
    member: (botId, lineUserId) => botKey(botId, 'member', lineUserId),
    memberLog: (botId, lineUserId) => botKey(botId, 'member_log', lineUserId),

    // ── 標籤 ──
    tags: (botId) => botKey(botId, 'tags'),
    tagMembers: (botId, tag) => botKey(botId, 'tag_members', tag),
    tagEntities: (botId, entityType, tag) => botKey(botId, `tag_${entityType}s`, tag),

    // ── 關鍵字回覆 ──
    keywords: (botId) => botKey(botId, 'keywords'),
    keyword: (botId, keywordId) => botKey(botId, 'keyword', keywordId),
    keywordStats: (botId) => botKey(botId, 'keyword_stats'),

    // ── 訊息素材 ──
    flexList: (botId) => botKey(botId, 'flex_list'),
    flex: (botId, flexId) => botKey(botId, 'flex', flexId),
    imagemaps: (botId) => botKey(botId, 'imagemaps'),
    images: (botId) => botKey(botId, 'images'),
    message: (botId, messageId) => botKey(botId, 'message', messageId),
    messageStats: (botId) => botKey(botId, 'message_stats'),
    quickReplies: (botId) => botKey(botId, 'quick_replies'),
    quickReply: (botId, quickReplyId) => botKey(botId, 'quick_reply', quickReplyId),
    welcome: (botId) => botKey(botId, 'welcome'),

    // ── 圖文選單 ──
    richMenuMeta: (botId, richMenuId) => botKey(botId, 'richmenu_meta', richMenuId),
    segmentedRichMenuRules: (botId) => botKey(botId, 'richmenu_segmented_rules'),

    // ── 等級 ──
    tierConfig: (botId) => botKey(botId, 'tier_config'),

    // ── Flow ──
    flowList: (botId) => botKey(botId, 'flow_list'),
    flow: (botId, flowId) => botKey(botId, 'flow', flowId),
    flowVersion: (botId, flowId, version) => botKey(botId, 'flow_version', flowId, String(version)),
};

/**
 * 關於「人」的資料。
 *
 * 判斷標準：換一個 bot 之後這筆資料還有意義嗎？有 → user，沒有 → bot。
 * rate limit 限制的是一個人的呼叫速率，不是一個 bot 的，所以在這裡。
 */
export const UserKeys = {
    prefix: (userId) => `${userKey(userId, 'x').slice(0, -1)}`,
    bots: (userId) => userKey(userId, 'bots'),
    profile: (userId) => userKey(userId, 'profile'),
    rateLimit: (userId, windowIndex) => userKey(userId, 'rl', String(windowIndex)),
};

export const InviteKeys = {
    token: (token) => `${KV_PREFIX.INVITE}${SEPARATOR}${assertComponent(token, 'token')}`,
};

/**
 * v1 命名空間的 key —— 正式環境現有的 924 個 key 就長這樣。
 *
 * 只給 migration 讀取舊資料用，新的程式碼一律用 BotKeys / UserKeys。
 * 這些 key 綁的是「呼叫者本人的 userId」，所以同一個人的多個 bot 共用一份
 * 資料（正式環境已有 owner 持有兩個 bot，兩邊的會員因此混在一起）；這正是要收斂掉的原因。
 *
 * 用底線，因為那是既有資料的格式，不是選擇。
 */
export const V1Keys = {
    // 身分與憑證
    accessTokens: (userId) => `access_tokens_${userId}`,
    currentToken: (userId) => `current_token_${userId}`,
    token: (userId) => `token_${userId}`,
    destinationUser: (destination) => `destination_user_${destination}`,

    // 會員
    memberList: (userId) => `member_list_${userId}`,
    memberProfile: (userId, memberId) => `member_profile_${userId}_${memberId}`,
    memberLog: (userId, memberId) => `member_log_${userId}_${memberId}`,

    // 標籤
    tagList: (userId) => `tag_list_${userId}`,
    tagEntities: (userId, entityType, tag) => `tag_${entityType}s_${userId}_${tag}`,

    // 關鍵字
    keywordReplyList: (userId) => `keyword_reply_list_${userId}`,
    keyword: (userId, keywordId) => `keyword_${userId}_${keywordId}`,
    keywordStats: (userId) => `keyword_stats_${userId}`,

    // 素材
    flexList: (userId) => `flex_list_${userId}`,
    flex: (userId, flexId) => `flex_${userId}_${flexId}`,
    imagemap: (userId) => `imagemap_${userId}`,
    imageList: (userId) => `image_list_${userId}`,
    message: (userId, messageId) => `message_${userId}_${messageId}`,
    messageStats: (userId) => `message_stats_${userId}`,
    quickReplyList: (userId) => `quick_reply_list_${userId}`,
    quickReplies: (userId) => `quick_replies_${userId}`,
    welcomeMessage: (userId) => `welcome_message_${userId}`,

    // 選單與等級
    richmenuMeta: (userId, richMenuId) => `richmenu_meta_${userId}_${richMenuId}`,
    segmentedRichMenuRules: (userId) => `richmenu_segmented_rules_${userId}`,
    tierConfig: (userId) => `tier_config_${userId}`,

    // 人
    profile: (userId) => `profile_${userId}`,

    // Flow（已經有 botId 這個維度）
    flowList: (userId, botId) => `flow_list_${userId}_${botId}`,
    flow: (userId, botId, flowId) => `flow_${userId}_${botId}_${flowId}`,
};

/**
 * 備份用的命名空間（`legacy:` 前綴）。
 *
 * 與 V1Keys 不同：V1Keys 是正式環境實際存在的舊 key，這組是 migration 搬移
 * 前把原始值另存一份的位置。保留原樣，既有測試依賴它。
 */
export const LegacyKeys = {
    userKeywords: (userId) => `${KV_PREFIX.LEGACY}:user:${userId}:keywords`,
    userFlexList: (userId) => `${KV_PREFIX.LEGACY}:user:${userId}:flex_list`,
};
