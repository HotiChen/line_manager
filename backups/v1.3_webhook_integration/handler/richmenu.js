import { jsonResponse } from "../lib/utils.js";

/**
 * 取得 Richmenu 列表，已整合別名 (Alias) 資訊
 */
export async function handleGetRichMenuList(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const info = accessTokens[project];
  const token = (typeof info === "object" && info !== null) ? info.token : info;

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  try {
    // 步驟 1: 平行取得「選單列表」與「別名列表」
    const [menuListRes, aliasListRes] = await Promise.all([
      fetch("https://api.line.me/v2/bot/richmenu/list", {
        headers: { Authorization: `Bearer ${token}` }
      }),
      fetch("https://api.line.me/v2/bot/richmenu/alias/list", {
        headers: { Authorization: `Bearer ${token}` }
      })
    ]);

    if (!menuListRes.ok) {
      throw new Error(`Failed to fetch Rich Menu list: ${menuListRes.status}`);
    }

    const menuData = await menuListRes.json();
    let aliasData = { aliases: [] };
    if (aliasListRes.ok) {
      aliasData = await aliasListRes.json();
    } else {
      console.warn("無法取得別名列表，將不包含別名資訊。");
    }

    // 步驟 2: 建立一個方便查詢的別名對照表 (Map)
    const aliasMap = new Map();
    if (aliasData.aliases) {
      for (const alias of aliasData.aliases) {
        aliasMap.set(alias.richMenuId, alias.richMenuAliasId);
      }
    }

    // 步驟 3: 組合資料，將別名加到對應的選單物件上
    const combinedRichMenus = (menuData.richmenus || []).map(menu => {
      return {
        ...menu,
        richMenuAliasId: aliasMap.get(menu.richMenuId) || ""
      };
    });

    return jsonResponse({ richmenus: combinedRichMenus });

  } catch (err) {
    console.error("在 handleGetRichMenuList 中發生錯誤:", err);
    return jsonResponse({ error: "無法取得完整的 Rich Menu 資料。" }, 500);
  }
}

/**
 * 取得 Richmenu 縮圖
 */
export async function handleGetRichMenuImage(env, userId, richMenuId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const info = accessTokens[project];
  const token = (typeof info === "object" && info !== null) ? info.token : info;

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

/**
 * 取得 Richmenu metadata
 */
export async function handleGetRichMenuMetadata(env, userId, richMenuId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const info = accessTokens[project];
  const token = (typeof info === "object" && info !== null) ? info.token : info;

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  const response = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) return jsonResponse({ error: `Failed to fetch Rich Menu metadata (status: ${response.status})` }, response.status);

  const metadata = await response.json();
  return jsonResponse(metadata);
}

/**
 * 取得預設 Richmenu ID
 */
export async function handleGetDefaultRichMenuId(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const info = accessTokens[project];
  const token = (typeof info === "object" && info !== null) ? info.token : info;

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  const response = await fetch("https://api.line.me/v2/bot/user/all/richmenu", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) return jsonResponse({ error: "Failed to fetch Default Richmenu" }, response.status);

  const data = await response.json();
  return jsonResponse({ richMenuId: data.richMenuId });
}

/**
 * 同步 Richmenus
 */
export async function handleSyncRichmenus(request, env, userId) {
  try {
    let payload = {};
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      // Handle same structure as old version
      const add = [{
        name: form.get("name"),
        diamention: JSON.parse(form.get("diamention") || "[]"),
        areas: JSON.parse(form.get("areas") || "[]"),
        alias: form.get("alias"),
        chatBarText: form.get("chatBarText"),
        imageFile: form.get("imageFile") || null
      }];
      payload = { add, update: [], remove: [], setDefault: null };
    } else {
      payload = await request.json();
    }

    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);

    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const info = accessTokens[project];
    const token = (typeof info === "object" && info !== null) ? info.token : info;

    if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

    const results = { added: [], updated: [], removed: [], errors: [] };
    const { add = [], update = [], remove = [], setDefault } = payload;

    await handleAddMenus(add, token, results);
    await handleRemoveMenus(remove, token, results);
    await handleSetDefaultRichMenu(setDefault, token, results);

    return jsonResponse(results);
  } catch (err) {
    console.error("[handleSyncRichmenus] ❌ 發生錯誤:", err);
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * 取得別名列表
 */
export async function handleGetAliasList(env, userId) {
  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const info = accessTokens[project];
  const token = (typeof info === "object" && info !== null) ? info.token : info;

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  try {
    const response = await fetch("https://api.line.me/v2/bot/richmenu/alias/list", {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[getAliasList] LINE API 錯誤 ${response.status} - ${errorText}`);
    }

    return jsonResponse(await response.json());
  } catch (err) {
    console.error("[getAliasList] ❌ 錯誤：", err);
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * 批次設定別名
 */
export async function handleBatchSetAlias(request, env, userId) {
  const { aliases } = await request.json();
  if (!Array.isArray(aliases)) return jsonResponse({ error: "Invalid alias list" }, 400);

  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  const info = accessTokens[project];
  const token = (typeof info === "object" && info !== null) ? info.token : info;

  if (!token) return jsonResponse({ error: "No token found for current project" }, 404);

  const results = [];
  for (const item of aliases) {
    try {
      const response = await fetch("https://api.line.me/v2/bot/richmenu/alias", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(item)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`API 錯誤 (${response.status}): ${text}`);
      }
      results.push({ alias: item.alias, richMenuId: item.richMenuId, success: true });
    } catch (err) {
      results.push({ alias: item.alias, error: err.message });
    }
  }
  return jsonResponse({ results });
}

// Helper 函式
async function handleAddMenus(add, token, results) {
  for (const item of add) {
    try {
      console.log("[handleAddMenus] Processing item:", item.name);
      console.log("[handleAddMenus] Areas:", JSON.stringify(item.areas, null, 2));

      const res = await fetch("https://api.line.me/v2/bot/richmenu", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: item.name,
          size: { width: item.diamention[0], height: item.diamention[1] },
          selected: false,
          chatBarText: item.chatBarText || "選單",
          areas: item.areas
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`[新增失敗] LINE API 回傳 ${res.status} - ${errorText}`);
      }

      const { richMenuId } = await res.json();

      if (item.imageFile) {
        const arrayBuffer = await item.imageFile.arrayBuffer();
        const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": item.imageFile.type || "image/jpeg"
          },
          body: arrayBuffer
        });
        if (!uploadRes.ok) {
          const uploadError = await uploadRes.text();
          throw new Error(`[圖片上傳失敗] ${uploadRes.status} - ${uploadError}`);
        }
      }

      if (item.alias) {
        const aliasRes = await fetch("https://api.line.me/v2/bot/richmenu/alias", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ richMenuAliasId: item.alias, richMenuId })
        });
        if (!aliasRes.ok) {
          console.warn(`[Alias設定失敗] ${await aliasRes.text()}`);
        }
      }

      results.added.push({ name: item.name, richMenuId });
    } catch (err) {
      results.errors.push({ name: item.name, error: err.message });
    }
  }
}

async function handleRemoveMenus(remove, token, results) {
  for (const richMenuId of remove) {
    try {
      // 刪除相關別名
      const aliasListRes = await fetch("https://api.line.me/v2/bot/richmenu/alias/list", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (aliasListRes.ok) {
        const { aliases = [] } = await aliasListRes.json();
        const myAliases = aliases.filter(a => a.richMenuId === richMenuId);
        for (const a of myAliases) {
          await fetch(`https://api.line.me/v2/bot/richmenu/alias/${a.richMenuAliasId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
          });
        }
      }

      // 刪除選單本體
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error("刪除失敗");
      results.removed.push(richMenuId);
    } catch (err) {
      results.errors.push({ richMenuId, error: err.message });
    }
  }
}

async function handleSetDefaultRichMenu(setDefault, token, results) {
  if (setDefault?.richMenuId) {
    try {
      const res = await fetch("https://api.line.me/v2/bot/user/all/richmenu", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ richMenuId: setDefault.richMenuId })
      });
      if (!res.ok) throw new Error("設定失敗");
      results.setDefault = setDefault;
    } catch (err) {
      results.errors.push({ richMenuId: setDefault.richMenuId, error: err.message });
    }
  }
}

export function route(request, env, userId, pathname) {
  if (pathname === "/richmenu/list") return handleGetRichMenuList(env, userId);
  if (pathname === "/richmenu/default") return handleGetDefaultRichMenuId(env, userId);
  if (pathname === "/alias/list") return handleGetAliasList(env, userId);
  if (pathname === "/alias/batch") return handleBatchSetAlias(request, env, userId);

  if (pathname.startsWith("/richmenu/image/")) {
    const id = pathname.split("/").pop();
    return handleGetRichMenuImage(env, userId, id);
  }
  if (pathname.startsWith("/richmenu/metadata/")) {
    const id = pathname.split("/").pop();
    return handleGetRichMenuMetadata(env, userId, id);
  }
  if (pathname === "/richmenu/sync") return handleSyncRichmenus(request, env, userId);

  return jsonResponse({ success: false, error: "Invalid richmenu route" }, 404);
}