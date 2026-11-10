// lib/token.js
import { jsonResponse } from "../lib/utils.js";
import { saveAccessToken } from "../lib/token_store.js";

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

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};

  // 暫時只允許一個官方帳號。
  //
  // 所有資料的 KV key 綁的是「登入的人」而不是「官方帳號」
  // （member_list_${userId}、keyword_reply_list_${userId}…），所以同一個登入
  // 底下的第二個帳號會跟第一個共用同一份關鍵字、會員與標籤。使用者看到的是
  // 「我切了帳號但資料沒變」，而他會合理地把它當成資料遺失來回報。
  //
  // 在 botId 統一完成前（docs/ARCHITECTURE_PLATFORM.md 第十三節），明確拒絕
  // 並說明原因，比讓人踩到再去懷疑資料不見要好。
  // 只擋新增 —— 既有已經有兩個帳號的使用者不受影響。
  const existing = Object.entries(accessTokens)
    .find(([, data]) => data && typeof data === "object"
      && typeof data.destination === "string" && data.destination !== destination);

  if (existing) {
    const [existingProject, existingData] = existing;
    return jsonResponse({
      error: "目前每個帳號只能綁定一個 LINE 官方帳號。多帳號支援還在開發中（資料隔離尚未完成，第二個帳號會與第一個共用關鍵字與會員資料）。",
      existingProject,
      existingDisplayName: existingData.displayName || existingProject
    }, 409);
  }

  // 加密寫入。缺金鑰時 saveAccessToken 會丟錯 —— 不可降級存明文，
  // 否則「已加密」就變成一個沒有根據的假設。
  try {
    await saveAccessToken(env, userId, project, { token, destination, displayName });
  } catch (err) {
    // 只記在伺服器端，不把設定細節回給呼叫端
    console.error("[Token] 無法加密儲存 access token:", err.message);
    return jsonResponse({ error: "Token storage is not configured" }, 503);
  }

  // 反查索引在加密寫入成功之後才建立，失敗時不留下半筆資料
  await env.KV_LINE_STORAGE.put(`destination_user_${destination}`, userId);

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
 * 取得當前選定的專案
 *
 * Post-conditions: 回傳 project 名稱與 botId（destination）。
 *
 * 絕不回傳 access token。先前這裡會回 `{ project, token }`，而那是 LINE
 * channel 的完全控制權；全 repo 沒有任何呼叫端，前端也完全不直接呼叫
 * api.line.me，所以沒有任何正當需求。端點保留（萬一有看不見的呼叫端還是能
 * 知道當前專案），但祕密不外流。
 */
export async function handleGetCurrentToken(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const projectInfo = accessTokens[project];

  // 舊版把 token 直接存成字串，新版是 { token, destination, displayName }。
  // 兩種都只用來判斷「這個專案是否已設定」，值本身不外流。
  const configured = typeof projectInfo === "object" && projectInfo !== null
    ? Boolean(projectInfo.token)
    : Boolean(projectInfo);

  if (!configured) return jsonResponse({ error: "No token found for current project" }, 404);

  const botId = (typeof projectInfo === "object" && projectInfo !== null
    && typeof projectInfo.destination === "string")
    ? projectInfo.destination
    : null;

  return jsonResponse({ project, botId });
}

/**
 * handleListUserProjects
 * 列出用戶擁有的所有專案列表（包含個人與團隊）
 * 
 * Post-conditions: 回傳合併後的專案列表物件 { name: id }
 */
export async function handleListUserProjects(env, userId) {
  // 注意 Promise.all 裡不要寫 `kv.get(..) || {}` —— `||` 會作用在 Promise 上，
  // 而 Promise 永遠 truthy，預設值從來不會生效。先前就是這樣寫的，於是沒有
  // user:<id>:bots 的使用者在 `userBotsData.bots` 這行拋 TypeError，整個
  // /token/list 回 500；而後台列出專案只靠這一個端點。
  const [accessTokens, userBotsData] = await Promise.all([
    env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }),
    env.KV_LINE_STORAGE.get(`user:${userId}:bots`, { type: "json" })
  ]);

  // 值一律是 botId 字串。
  //
  // 不可回傳 access token：那是 LINE channel 的完全控制權，前端沒有任何地方
  // 需要它，而前端還有裸 innerHTML，任何一處 XSS 都能把它拿走。
  //
  // 形狀統一成字串而不是挖掉 token 欄位，是因為前端三個消費者
  // （token_manager.js、team_management.js、flow_designer_data_loader.js）
  // 都把值當 botId 用，而先前的回應是混合的 —— access_tokens 來的是物件、
  // user:<id>:bots 來的是字串，所以那三處一直在渲染 [object Object]。
  const projects = {};
  for (const [name, info] of Object.entries(accessTokens || {})) {
    // 舊格式把 token 直接存成字串，沒有 destination 可用 —— 回 null，
    // 絕不回那個字串本身
    projects[name] = (info && typeof info === "object" && typeof info.destination === "string")
      ? info.destination
      : null;
  }

  const bots = Array.isArray(userBotsData?.bots) ? userBotsData.bots : [];
  for (const bot of bots) {
    if (!bot || typeof bot.botId !== "string" || bot.botId === "") continue;
    // 先前的去重寫成 `Object.values(mergedProjects).includes(bot.botId)`，
    // 但那時 values 是物件，跟字串永遠不相等，所以從來沒去重成功
    if (Object.values(projects).includes(bot.botId)) continue;

    const botInfo = await env.KV_LINE_STORAGE.get(`bot:${bot.botId}:info`, { type: "json" });
    const projectName = botInfo?.name || `Bot (${bot.botId.substring(0, 8)}...)`;
    const finalName = projects[projectName] === undefined
      ? projectName
      : `${projectName} (${bot.botId.substring(0, 4)})`;
    projects[finalName] = bot.botId;
  }

  return jsonResponse(projects);
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