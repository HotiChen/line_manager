/**
 * 註冊官方帳號時要一併建立的 bot 層級紀錄
 *
 * 問題：/token/register 只寫 access_tokens_${userId} 與 destination_user_${destination}。
 * bot:${botId}:owner / info / permissions 與 user:${userId}:bots 只有 migration 會寫，所以新註冊的
 * 使用者呼叫任何 withPermission 的路由（/team/*、/api/v1/systems、/member/demo/*）一律 403。
 *
 * 規則：
 *   - 缺什麼補什麼，已存在的絕不覆蓋。permissions 裡可能已有受邀成員，重設等於把人踢出去；
 *     user:bots 的 currentBotId 是使用者自己切換的結果。
 *   - 冪等：全部都在時不寫任何東西。
 *   - 形狀比照 migration/migrate.js 回填的那一份。
 *   - botId / userId 不合法（空、含 ':'）→ 什麼都不寫。
 */
import { BotKeys, UserKeys } from "./kv_schema.js";

function usable(value) {
  return typeof value === "string" && value !== "" && !value.includes(":");
}

/**
 * @param {Object} env
 * @param {{botId: string, userId: string, displayName?: string, project?: string}} bot
 * @param {{makeCurrent?: boolean}} [options] makeCurrent:false 時只加進清單，不設 currentBotId
 * @returns {Promise<{skipped: boolean, created: string[]}>}
 */
export async function ensureBotRecords(env, { botId, userId, displayName, project } = {}, options = {}) {
  if (!env?.KV_LINE_STORAGE || !usable(botId) || !usable(userId)) {
    return { skipped: true, created: [] };
  }
  const kv = env.KV_LINE_STORAGE;
  const makeCurrent = options.makeCurrent !== false;
  const name = (typeof displayName === "string" && displayName !== "") ? displayName : project;
  const created = [];

  if ((await kv.get(BotKeys.owner(botId))) === null) {
    await kv.put(BotKeys.owner(botId), userId);
    created.push("owner");
  }

  if ((await kv.get(BotKeys.info(botId))) === null) {
    await kv.put(BotKeys.info(botId), JSON.stringify({
      botId,
      displayName: name,
      createdBy: userId,
      originalProjectName: project,
    }));
    created.push("info");
  }

  // permissions 不覆蓋：裡面可能已有邀請進來的同事
  if ((await kv.get(BotKeys.permissions(botId))) === null) {
    await kv.put(BotKeys.permissions(botId), JSON.stringify({
      users: [{
        userId,
        role: "owner",
        displayName: name,
        addedAt: new Date().toISOString(),
        addedBy: "registration",
      }],
    }));
    created.push("permissions");
  }

  const userBotsKey = UserKeys.bots(userId);
  const stored = await kv.get(userBotsKey, { type: "json" });
  const userBots = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const bots = Array.isArray(userBots.bots) ? userBots.bots : [];

  let changed = false;
  const next = { ...userBots, bots: [...bots] };
  if (!bots.some((b) => b && b.botId === botId)) {
    next.bots.push({ botId, role: "owner", displayName: name, joinedAt: new Date().toISOString() });
    changed = true;
  }
  if (makeCurrent && !userBots.currentBotId) {
    next.currentBotId = botId;
    changed = true;
  } else if (!("currentBotId" in next)) {
    next.currentBotId = null;
    changed = changed || !stored;
  }
  if (changed) {
    await kv.put(userBotsKey, JSON.stringify(next));
    created.push("userBots");
  }

  return { skipped: false, created };
}
