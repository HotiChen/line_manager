// lib/richmenu.js

export async function handleGetRichMenuList(env, userId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const token = accessTokens[project];
  
    if (!token) return jsonResponse({ error: "No token found for current project" }, 404);
  
    const response = await fetch("https://api.line.me/v2/bot/richmenu/list", {
      headers: { Authorization: `Bearer ${token}` }
    });
  
    if (!response.ok) return jsonResponse({ error: "Failed to fetch Rich Menu list" }, response.status);
  
    return jsonResponse(await response.json());
  }
  
  export async function handleGetRichMenuImage(env, userId, richMenuId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
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
  
  export async function handleGetRichMenuMetadata(env, userId, richMenuId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const token = accessTokens[project];
  
    if (!token) return jsonResponse({ error: "No token found for current project" }, 404);
  
    const response = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
  
    if (!response.ok) return jsonResponse({ error: `Failed to fetch Rich Menu metadata (status: ${response.status})` }, response.status);
  
    const metadata = await response.json();
    return jsonResponse(metadata);
  }
  
  export async function handleGetDefaultRichMenuId(env, userId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const token = accessTokens[project];
  
    if (!token) return jsonResponse({ error: "No token found for current project" }, 404);
  
    const response = await fetch("https://api.line.me/v2/bot/user/all/richmenu", {
      headers: { Authorization: `Bearer ${token}` }
    });
  
    if (!response.ok) return jsonResponse({ error: "Failed to fetch Default Richmenu" }, response.status);
  
    const data = await response.json();
    return jsonResponse({ richMenuId: data.richMenuId });
  }


  export async function handleSyncRichmenus(request, env, userId, form = null) {
    try {
      let payload = {};
  
      if (form) {
        const jsonStr = form.get("json"); // ✅ 你前端的 FormData 裡會加 .append("json", JSON.stringify(payload))
        try {
          payload = JSON.parse(jsonStr);
        } catch (err) {
          return jsonResponse({ error: "Invalid JSON payload in formData" }, 400);
        }
      } else {
        const raw = await request.text();
        payload = JSON.parse(raw);
      }
  
      // const raw = await request.text();
      //console.log("[handleSyncRichmenus] Raw body text =", raw);
  
      // const payload = JSON.parse(raw);
      console.log("[handleSyncRichmenus] Parsed JSON =", payload);
      
      if (form) {
        // 直接從 form 裡取出各欄位
        const add = [{
          name: form.get("name"),
          diamention: JSON.parse(form.get("diamention") || "[]"),
          areas: JSON.parse(form.get("areas") || "[]"),
          alias: form.get("alias"),
          chatBarText: form.get("chatBarText"),
          imageFile: form.get("imageFile") || null,
          imageBase64: form.get("imageBase64") || null,
        }];
        payload = { add, update: [], remove: [], setDefault: null };
      }
      // 其餘程式碼不變，繼續使用解構
      const { add = [], update = [], remove = [], setDefault } = payload;
  
      const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
      if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
      const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
      const token = accessTokens[project];
      if (!token) return jsonResponse({ error: "No token found for current project" }, 404);
  
      const results = { added: [], updated: [], removed: [], errors: [] };
      console.log("[handleSyncRichmenus] 🧾 add 陣列 =", JSON.stringify(add, null, 2));
      //console.log("add [] : "+JSON.stringify(add))
      await handleAddMenus(add, token, results);
      await handleRemoveMenus(remove, token, results);
      //await handleUpdateMenus(update, results);
      await handleSetDefaultRichMenu(setDefault, token, results);
  
      return jsonResponse(results);
    } catch (err) {
      console.error("[handleSyncRichmenus] ❌ 發生錯誤:", err);
      return jsonResponse({ error: err.message }, 500);
    }
  }
  



export function route(request, env, userId, pathname) {
    if (pathname === "/richmenu/list") return handleGetRichmenuList(env, userId);
    if (pathname.startsWith("/richmenu/image/")) {
      const id = pathname.split("/")[3];
      return handleGetRichMenuImage(env, userId, id);
    }
    if (pathname.startsWith("/richmenu/metadata/")) {
      const id = pathname.split("/")[3];
      return handleGetRichMenuMetadata(env, userId, id);
    }
    if (pathname === "/richmenu/sync") return handleSyncRichmenus(request, env, userId);
    if (pathname === "/richmenu/delete") return handleDeleteRichmenu(request, env, userId);
    if (pathname === "/richmenu/set-default") return handleSetDefaultRichmenu(request, env, userId);
    if (pathname === "/richmenu/set-alias") return handleSetAlias(request, env, userId);
    if (pathname === "/richmenu/delete-alias") return handleDeleteAlias(request, env, userId);
  
    return jsonResponse({ success: false, error: "Invalid richmenu route" }, 404);
  }

  // 工具函式應該來自 utils.js
  import { jsonResponse } from "../lib/utils.js";