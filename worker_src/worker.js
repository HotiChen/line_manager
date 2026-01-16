export default {
  async fetch(request, env) {
    const url = new URL(request.url); 

    // 🔹 CORS 預檢請求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,  // ✅ 使用 204 No Content，避免瀏覽器誤判
        headers: getCorsHeaders(),
      });
    }

    // 🔹 取得 `userId`（前端應該傳 `X-User-Id`）
    const userId = request.headers.get("X-User-Id");
    if (!userId) return jsonResponse({ error: "Missing User ID" }, 401);

    // 🔹 API 路由
    if (url.pathname === "/token/register" && request.method === "POST") {
      return await registerAccessToken(request, env, userId);
    }

    if (url.pathname === "/token/set" && request.method === "POST") {
      return await setCurrentToken(request, env, userId);
    }

    if (url.pathname === "/token/delete" && request.method === "DELETE") {
      return await deleteAccessToken(request, env, userId);
    }

    if (url.pathname === "/token/current" && request.method === "GET") {
      return await getCurrentToken(env, userId);
    }

    if (url.pathname === "/richmenu/list" && request.method === "GET") {
      return await getRichMenuList(env, userId);
    }

    if (url.pathname.startsWith("/richmenu/image/")) {
      const richMenuId = url.pathname.split("/").pop();
      return await getRichMenuImage(env, userId, richMenuId);
    }

    // 取得 UserID 對應的所有專案
    if (url.pathname === "/token/list" && request.method === "GET") {
      return await listUserProjects(env, userId);
    }
    
    // 取得 Richmenu metadata
    if (url.pathname.startsWith("/richmenu/metadata/")) {
      const richMenuId = url.pathname.split("/").pop();
      return await getRichMenuMetadata(env, userId, richMenuId);
    }

    // 7️⃣ 取得 Default Richmenu ID
    if (url.pathname === "/richmenu/default" && request.method === "GET") {
      return await getDefaultRichMenuId(env, userId);
    }
    return jsonResponse({ error: "Not Found" }, 404);
  }
};

// ✅ 1️⃣ 註冊 Access Token
async function registerAccessToken(request, env, userId) {

  const { project, token } = await request.json();
  if (!project || !token) {
    return jsonResponse({ error: "Missing project or token" }, 400);
  }


  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  accessTokens[project] = token;

  await env.KV_LINE_STORAGE.put(`access_tokens_${userId}`, JSON.stringify(accessTokens));

  return jsonResponse({ success: `Access token registered for ${project}` });
}

// ✅ 2️⃣ 設定當前使用的 Access Token
async function setCurrentToken(request, env, userId) {
  const { project } = await request.json();
  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
 
  if (!accessTokens[project]) return jsonResponse({ error: "Project not found" }, 404);

  await env.KV_LINE_STORAGE.put(`current_token_${userId}`, project);
  return jsonResponse({ success: `Current token set to ${project}` });
}

// ✅ 3️⃣ 刪除 Access Token
async function deleteAccessToken(request, env, userId) {
  const { project } = await request.json();
  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};

  if (!accessTokens[project]) return jsonResponse({ error: "Project not found" }, 404);

  delete accessTokens[project];
  await env.KV_LINE_STORAGE.put(`access_tokens_${userId}`, JSON.stringify(accessTokens));

  let currentToken = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (currentToken === project) {
    await env.KV_LINE_STORAGE.delete(`current_token_${userId}`);
  }

  return jsonResponse({ success: `Access token for ${project} deleted` });
}

// ✅ 4️⃣ 取得當前使用的 Access Token
async function getCurrentToken(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  return jsonResponse({ project, token: accessTokens[project] });
}


// ✅ 取得 UserID 的所有專案
async function listUserProjects(env, userId) {
  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  return new Response(JSON.stringify(accessTokens), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// ✅ 5️⃣ 取得 Richmenu 列表
async function getRichMenuList(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const token = accessTokens[project];



  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  const response = await fetch("https://api.line.me/v2/bot/richmenu/list", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) return jsonResponse({ error: "Failed to fetch Rich Menu list" }, response.status);

  return jsonResponse(await response.json());
}

// ✅ 6️⃣ 取得 Richmenu 縮圖
async function getRichMenuImage(env, userId, richMenuId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const token = accessTokens[project];

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "image/png" },
    cf: { cacheTtl: 0 }
  });

  if (!response.ok) return jsonResponse({ error: `Failed to fetch Rich Menu image (status: ${response.status})` }, response.status);

  return new Response(await response.arrayBuffer(), {
    headers: {
      "Content-Type": "image/png",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// ✅ 統一 JSON Response（確保 CORS Headers 存在）
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: getCorsHeaders(),
  });
}

// ✅ 取得 CORS Headers
function getCorsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id"
  };
}

// ✅ 取得 Richmenu metadata
// ✅ 取得 Richmenu metadata
async function getRichMenuMetadata(env, userId, richMenuId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const token = accessTokens[project];

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  const response = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) return jsonResponse({ error: `Failed to fetch Rich Menu metadata (status: ${response.status})` }, response.status);

  const metadata = await response.json();
  return jsonResponse(metadata); // ✅ 傳回完整 metadata（包含 action）
}



// ✅ 取得 Default Richmenu ID
async function getDefaultRichMenuId(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const token = accessTokens[project];

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  const response = await fetch("https://api.line.me/v2/bot/user/all/richmenu", {
      headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) return jsonResponse({ error: "Failed to fetch Default Richmenu" }, response.status);

  const data = await response.json();
  return jsonResponse({ richMenuId: data.richMenuId });
}