// lib/token.js

export async function handleRegisterAccessToken(request, env, userId) {
  console.log(`📢 [DEBUG] handleRegisterAccessToken 被呼叫, userId=${userId}`);

  const { project, token } = await request.json();
  if (!project || !token) {
    console.log("🚨 [ERROR] 缺少 project 或 token");
    return jsonResponse({ error: "Missing project or token" }, 400);
  }

  console.log(`📌 [INFO] 註冊 project=${project}, token=${token}`);

  // 呼叫 LINE 的 /v2/bot/info 取得 destination
  const infoRes = await fetch("https://api.line.me/v2/bot/info", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!infoRes.ok) {
    console.log("🚨 [ERROR] 無法取得 LINE bot info");
    return jsonResponse({ error: "Invalid LINE token" }, 400);
  }

  const info = await infoRes.json();
  const destination = info.userId;
  const displayName = info.displayName;

  console.log("✅ [INFO] destination =", destination);

  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};

  accessTokens[project] = {
    token,
    destination,
    displayName
  };

  console.log("✅ [INFO] 儲存 Access Token 至 KV_LINE_STORAGE");
  await env.KV_LINE_STORAGE.put(`access_tokens_${userId}`, JSON.stringify(accessTokens));

  // 也建立 destination 對應回 userId 的反查索引
  await env.KV_LINE_STORAGE.put(`destination_user_${destination}`, userId);

  return jsonResponse({ success: true, message: `Access token registered for ${project}`, destination });
}

export async function handleSetCurrentToken(request, env, userId) {
  const { project } = await request.json();
  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};

  // 支援舊版 (字串) 或新版 (物件) 檢查
  const info = accessTokens[project];
  if (!info || (typeof info === 'object' && !info.token)) {
    return jsonResponse({ error: "Project not found" }, 404);
  }

  await env.KV_LINE_STORAGE.put(`current_token_${userId}`, project);
  return jsonResponse({ success: true, message: `Current token set to ${project}` });
}

export async function handleDeleteAccessToken(request, env, userId) {
  const { project } = await request.json();
  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};

  if (!accessTokens[project]) return jsonResponse({ success: false, error: "Project not found" }, 404);

  delete accessTokens[project];
  await env.KV_LINE_STORAGE.put(`access_tokens_${userId}`, JSON.stringify(accessTokens));

  let currentToken = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (currentToken === project) {
    await env.KV_LINE_STORAGE.delete(`current_token_${userId}`);
  }

  return jsonResponse({ success: true, message: `Access token for ${project} deleted` });
}

export async function handleGetCurrentToken(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const projectInfo = accessTokens[project];

  // 支援舊版字串格式與新版物件格式
  const token = (typeof projectInfo === "object" && projectInfo !== null) ? projectInfo.token : projectInfo;

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  return jsonResponse({ project, token });
}

export async function handleListUserProjects(env, userId) {
  // 1. 獲取舊版 Access Tokens (Owner 專案)
  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};

  // 2. 獲取新版 User Bots (團隊專案)
  const userBotsKey = `user:${userId}:bots`; // 這裡應該用 UserKeys.bots(userId) 但這裡沒引入，直接拼字串
  const userBotsData = await env.KV_LINE_STORAGE.get(userBotsKey, { type: "json" }) || { bots: [] };

  // 3. 合併列表
  // 我們需要把 userBots 轉換成 { "Project Name": "Bot ID" } 的格式
  // 注意：這裡我們暫時用 Bot ID 作為 Token 的值，因為前端主要是用 Key 來顯示

  const mergedProjects = { ...accessTokens };

  for (const bot of userBotsData.bots) {
    // 嘗試獲取 Bot 資訊以顯示名稱
    const botInfoKey = `bot:${bot.botId}:info`;
    const botInfo = await env.KV_LINE_STORAGE.get(botInfoKey, { type: "json" });

    const projectName = botInfo?.name || `Bot (${bot.botId.substring(0, 8)}...)`;

    // 如果這個專案還不在列表中，就加進去
    // 我們用 Bot ID 作為 value，這樣前端選中時可以知道是哪個 Bot
    if (!Object.values(mergedProjects).includes(bot.botId)) {
      // 避免名稱衝突
      let finalProjectName = projectName;
      if (mergedProjects[finalProjectName]) {
        finalProjectName = `${projectName} (${bot.botId.substring(0, 4)})`;
      }
      mergedProjects[finalProjectName] = bot.botId;
    }
  }

  return new Response(JSON.stringify(mergedProjects), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export function route(request, env, userId, pathname) {
  if (pathname === "/token/register") return handleRegisterAccessToken(request, env, userId);
  if (pathname === "/token/set") return handleSetCurrentToken(request, env, userId);
  if (pathname === "/token/delete") return handleDeleteAccessToken(request, env, userId);
  if (pathname === "/token/current") return handleGetCurrentToken(env, userId);
  if (pathname === "/token/list") return handleListUserProjects(env, userId);
  return jsonResponse({ success: false, error: "Invalid token route" }, 404);
}

// 工具函式應該來自 utils.js
import { jsonResponse } from "../lib/utils.js";