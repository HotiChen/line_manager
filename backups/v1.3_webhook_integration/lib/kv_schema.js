/**
 * KV Schema Helpers
 * 統一管理 KV Key 的生成規則，避免 hardcode string
 */

export const KV_PREFIX = {
    BOT: 'bot',
    USER: 'user',
    INVITE: 'invite',
    LEGACY: 'legacy'
};

/**
 * 產生 Bot 相關的 Key
 */
export const BotKeys = {
    /**
     * Bot 基礎資訊
     * Key: bot:${botId}:info
     */
    info: (botId) => `${KV_PREFIX.BOT}:${botId}:info`,

    /**
     * Bot 權限設定
     * Key: bot:${botId}:permissions
     */
    permissions: (botId) => `${KV_PREFIX.BOT}:${botId}:permissions`,

    /**
     * Bot 的關鍵字列表
     * Key: bot:${botId}:keywords
     */
    keywords: (botId) => `${KV_PREFIX.BOT}:${botId}:keywords`,

    /**
     * Bot 的 Flex 訊息列表
     * Key: bot:${botId}:flex_list
     */
    flexList: (botId) => `${KV_PREFIX.BOT}:${botId}:flex_list`,

    /**
     * Bot 的 Imagemap 列表
     * Key: bot:${botId}:imagemaps
     */
    imagemaps: (botId) => `${KV_PREFIX.BOT}:${botId}:imagemaps`,

    /**
     * Bot 的標籤列表
     * Key: bot:${botId}:tags
     */
    tags: (botId) => `${KV_PREFIX.BOT}:${botId}:tags`,

    /**
     * Bot 的成員列表 (會員資料)
     * Key: bot:${botId}:members
     */
    members: (botId) => `${KV_PREFIX.BOT}:${botId}:members`,

    /**
     * Bot 的 Quick Reply 模板列表
     * Key: bot:${botId}:quick_replies
     */
    quickReplies: (botId) => `${KV_PREFIX.BOT}:${botId}:quick_replies`
};

/**
 * 產生 User 相關的 Key
 */
export const UserKeys = {
    /**
     * 使用者的 Bot 列表
     * Key: user:${userId}:bots
     */
    bots: (userId) => `${KV_PREFIX.USER}:${userId}:bots`,

    /**
     * 使用者 Profile (全域)
     * Key: user:${userId}:profile
     */
    profile: (userId) => `${KV_PREFIX.USER}:${userId}:profile`
};

/**
 * 產生 Invite 相關的 Key
 */
export const InviteKeys = {
    /**
     * 邀請 Token
     * Key: invite:${token}
     */
    token: (token) => `${KV_PREFIX.INVITE}:${token}`
};

/**
 * 產生 Legacy Key (用於備份或相容)
 */
export const LegacyKeys = {
    userKeywords: (userId) => `${KV_PREFIX.LEGACY}:user:${userId}:keywords`,
    userFlexList: (userId) => `${KV_PREFIX.LEGACY}:user:${userId}:flex_list`
};
