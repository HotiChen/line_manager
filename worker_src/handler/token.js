// lib/token.js
import { jsonResponse } from "../lib/utils.js";

/**
 * handleRegisterAccessToken
 * 註冊 LINE Channel Access Token，並自動取得 Bot 資訊
 * 
 * Pre-conditions:
 * - request body: { project: string, token: string }
 * - userId: 當前用戶 ID
 * 
 * Post-conditions:
 * - 驗證 Token 有效性並取得 destination (Bot ID)
 * - 儲存 Token 資訊到 KV: access_tokens_${userId}
 * - 建立反查索引: destination_user_${destination}
 */
export async function handleRegisterAccessToken(request, env, userId) {
  const { project, token } = await request.json();
  if (!project || !token) {
    return jsonResponse({ error: "Missing project or token" }, 400);
  }

  // 呼叫 LINE 的 /v2/bot/info 取得 destination
  const infoRes = await fetch("https://api.line.me/v2/bot/info", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!infoRes.ok) {
    return jsonResponse({ error: "Invalid LINE token" }, 400);
  }

  const info = await infoRes.json();
  const destination = info.userId;
  const displayName = info.displayName;

  const accessTokensKey = `access_tokens_${userId}`;
  const accessTokens = await env.KV_LINE_STORAGE.get(accessTokensKey, { type: "json" }) || {};

  accessTokens[project] = {
    token,
    destination,
    displayName
  };

  await Promise.all([
    env.KV_LINE_STORAGE.put(accessTokensKey, JSON.stringify(accessTokens)),
    env.KV_LINE_STORAGE.put(`destination_user_${destination}`, userId)
  ]);

  return jsonResponse({
    success: true,
    message: `Access token registered for ${project}`,
    destination
  });
}

/**
 * handleSetCurrentToken
 * 設定目前專案的 Active Token
 * 
 * Pre-conditions: project 名稱必須存在於 accessTokens 中
 * Post-conditions: 更新 KV 中的 current_token_${userId}
 */
export async function handleSetCurrentToken(request, env, userId) {
  const { project } = await request.json();
  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};

  const info = accessTokens[project];
  if (!info || (typeof info === 'object' && !info.token)) {
    return jsonResponse({ error: "Project not found" }, 404);
  }

  await env.KV_LINE_STORAGE.put(`current_token_${userId}`, project);
  return jsonResponse({ success: true, message: `Current token set to ${project}` });
}

/**
 * handleDeleteAccessToken
 * 刪除指定的 Access Token
 * 
 * Post-conditions: 移除 KV 中的專案資訊，若為目前使用專案則一併清除 current_token
 */
export async function handleDeleteAccessToken(request, env, userId) {
  const { project } = await request.json();
  const accessTokensKey = `access_tokens_${userId}`;
  const accessTokens = await env.KV_LINE_STORAGE.get(accessTokensKey, { type: "json" }) || {};

  if (!accessTokens[project]) {
    return jsonResponse({ success: false, error: "Project not found" }, 404);
  }

  delete accessTokens[project];
  await env.KV_LINE_STORAGE.put(accessTokensKey, JSON.stringify(accessTokens));

  const currentToken = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (currentToken === project) {
    await env.KV_LINE_STORAGE.delete(`current_token_${userId}`);
  }

  return jsonResponse({ success: true, message: `Access token for ${project} deleted` });
}

/**
 * handleGetCurrentToken
 * 取得當前專案使用的 Token 詳情
 * 
 * Post-conditions: 回傳 project 名稱與密鑰 token
 */
export async function handleGetCurrentToken(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const projectInfo = accessTokens[project];

  // 支援舊版字串格式與新版物件格式
  const token = (typeof projectInfo === "object" && projectInfo !== null) ? projectInfo.token : projectInfo;

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  return jsonResponse({ project, token });
}

/**
 * handleListUserProjects
 * 列出用戶擁有的所有專案列表（包含個人與團隊）
 * 
 * Post-conditions: 回傳合併後的專案列表物件 { name: id }
 */
export async function handleListUserProjects(env, userId) {
  const [accessTokens, userBotsData] = await Promise.all([
    env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {},
    env.KV_LINE_STORAGE.get(`user:${userId}:bots`, { type: "json" }) || { bots: [] }
  ]);

  const mergedProjects = { ...accessTokens };

  for (const bot of userBotsData.bots) {
    const botInfo = await env.KV_LINE_STORAGE.get(`bot:${bot.botId}:info`, { type: "json" });
    const projectName = botInfo?.name || `Bot (${bot.botId.substring(0, 8)}...)`;

    if (!Object.values(mergedProjects).includes(bot.botId)) {
      let finalProjectName = projectName;
      if (mergedProjects[finalProjectName]) {
        finalProjectName = `${projectName} (${bot.botId.substring(0, 4)})`;
      }
      mergedProjects[finalProjectName] = bot.botId;
    }
  }

  return jsonResponse(mergedProjects);
}

/**
 * route
 * 令牌管理模組路由
 */
export function route(request, env, userId, pathname) {
  if (pathname === "/token/register") return handleRegisterAccessToken(request, env, userId);
  if (pathname === "/token/set") return handleSetCurrentToken(request, env, userId);
  if (pathname === "/token/delete") return handleDeleteAccessToken(request, env, userId);
  if (pathname === "/token/current") return handleGetCurrentToken(env, userId);
  if (pathname === "/token/list") return handleListUserProjects(env, userId);
  return jsonResponse({ success: false, error: "Invalid token route" }, 404);
}