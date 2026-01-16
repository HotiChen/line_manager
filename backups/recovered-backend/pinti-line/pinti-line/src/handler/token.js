// lib/token.js

export async function handleRegisterAccessToken(request, env, userId) {
    console.log(`📢 [DEBUG] handleRegisterAccessToken 被呼叫, userId=${userId}`);
  
    const { project, token } = await request.json();
    if (!project || !token) {
      console.log("🚨 [ERROR] 缺少 project 或 token");
      return jsonResponse({ error: "Missing project or token" }, 400);
    }
  
    console.log(`📌 [INFO] 註冊 project=${project}, token=${token}`);
  
    let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    accessTokens[project] = token;
  
    console.log("✅ [INFO] 儲存 Access Token 至 KV_LINE_STORAGE");
    await env.KV_LINE_STORAGE.put(`access_tokens_${userId}`, JSON.stringify(accessTokens));
  
    return jsonResponse({ success: `Access token registered for ${project}` });
  }
  
  export async function handleSetCurrentToken(request, env, userId) {
    const { project } = await request.json();
    let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  
    if (!accessTokens[project]) return jsonResponse({ error: "Project not found" }, 404);
  
    await env.KV_LINE_STORAGE.put(`current_token_${userId}`, project);
    return jsonResponse({ success: `Current token set to ${project}` });
  }
  
  export async function handleDeleteAccessToken(request, env, userId) {
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
  
  export async function handleGetCurrentToken(env, userId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    return jsonResponse({ project, token: accessTokens[project] });
  }
  
  export async function handleListUserProjects(env, userId) {
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    return new Response(JSON.stringify(accessTokens), {
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