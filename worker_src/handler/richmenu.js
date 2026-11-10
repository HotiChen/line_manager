import { jsonResponse } from "../lib/utils.js";
import { getAccessTokenForProject, getCurrentAccessToken } from "../lib/token_store.js";

/**
 * handleGetRichMenuList
 * 取得 Richmenu 列表，已整合別名 (Alias) 資訊
 * 
 * Pre-conditions:
 * - userId: 當前用戶 ID
 * 
 * Post-conditions:
 * - 回傳包含 richmenus 陣列的物件，每個選單皆包含 richMenuAliasId
 */
export async function handleGetRichMenuList(env, userId) {
  if (!env || !userId) return jsonResponse({ error: "Missing env or userId" }, 400);

  const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
  if (!project) return jsonResponse({ error: "No current project set" }, 404);

  const token = await getAccessTokenForProject(env, userId, project);

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
    const combinedRichMenus = (menuData.richmenus || []).map(menu => ({
      ...menu,
      richMenuAliasId: aliasMap.get(menu.richMenuId) || ""
    }));

    return jsonResponse({ richmenus: combinedRichMenus });

  } catch (err) {
    // stack 僅留在伺服器端 log，不回傳給用戶端
    console.error("在 handleGetRichMenuList 中發生錯誤:", err.stack || err);
    return jsonResponse({
      error: "無法取得完整的 Rich Menu 資料。",
      details: err.message
    }, 500);
  }
}

/**
 * handleGetRichMenuImage
 * 取得 Richmenu 縮圖內容
 * 
 * Pre-conditions: richMenuId 必須有效
 * Post-conditions: 回傳 image/png 二進制數據
 */
export async function handleGetRichMenuImage(env, userId, richMenuId) {
  if (!env || !userId || !richMenuId) return jsonResponse({ error: "Missing required parameters" }, 400);

  const token = await getActiveToken(env, userId);
  if (!token) return jsonResponse({ error: "No active token" }, 404);

  const response = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "image/png" },
    cf: { cacheTtl: 0 }
  });

  if (!response.ok) {
    return jsonResponse({ error: `Failed to fetch Rich Menu image (status: ${response.status})` }, response.status);
  }

  return new Response(await response.arrayBuffer(), {
    headers: {
      "Content-Type": "image/png",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * handleGetRichMenuMetadata
 * 取得單個 Richmenu 的 Metadata 詳情
 * 
 * Pre-conditions: richMenuId 必須有效
 * Post-conditions: 回傳選單定義 JSON
 */
export async function handleGetRichMenuMetadata(env, userId, richMenuId) {
  if (!env || !userId || !richMenuId) return jsonResponse({ error: "Missing required parameters" }, 400);

  const token = await getActiveToken(env, userId);
  if (!token) return jsonResponse({ error: "No active token" }, 404);

  const response = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return jsonResponse({ error: `Failed to fetch Rich Menu metadata (status: ${response.status})` }, response.status);
  }

  return jsonResponse(await response.json());
}

/**
 * handleGetDefaultRichMenuId
 * 取得當前 LINE Bot 設定的預設選單 ID
 * 
 * Post-conditions: 回傳 { richMenuId: string }
 */
export async function handleGetDefaultRichMenuId(env, userId) {
  if (!env || !userId) return jsonResponse({ error: "Missing env or userId" }, 400);

  const token = await getActiveToken(env, userId);
  if (!token) return jsonResponse({ error: "No active token" }, 404);

  const response = await fetch("https://api.line.me/v2/bot/user/all/richmenu", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) return jsonResponse({ error: "Failed to fetch Default Richmenu" }, response.status);

  const data = await response.json();
  return jsonResponse({ richMenuId: data.richMenuId });
}

/**
 * handleSyncRichmenus
 * 同步 Richmenus (支援新增、刪除、設定預設)
 * 
 * Pre-conditions: 支援 multipart/form-data 或 JSON payload
 * Post-conditions: 執行批次操作並回傳結果報告結果
 */
export async function handleSyncRichmenus(request, env, userId) {
  if (!request || !env || !userId) return jsonResponse({ error: "Missing required parameters" }, 400);

  try {
    const token = await getActiveToken(env, userId);
    if (!token) return jsonResponse({ error: "No active token" }, 404);

    let payload = {};
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
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

    const { add = [], remove = [], setDefault } = payload;
    const results = { added: [], updated: [], removed: [], errors: [] };

    await Promise.all([
      handleAddMenus(add, token, results),
      handleRemoveMenus(remove, token, results),
      handleSetDefaultRichMenu(setDefault, token, results)
    ]);

    return jsonResponse(results);
  } catch (err) {
    console.error("[handleSyncRichmenus] ❌ 發生錯誤:", err);
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * handleGetAliasList
 * 取得當前 Bot 的別名列表
 */
export async function handleGetAliasList(env, userId) {
  const token = await getActiveToken(env, userId);
  if (!token) return jsonResponse({ error: "No active token" }, 404);

  try {
    const response = await fetch("https://api.line.me/v2/bot/richmenu/alias/list", {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`LINE API 錯誤 ${response.status}`);
    }

    return jsonResponse(await response.json());
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * handleBatchSetAlias
 * 批次建立別名
 */
export async function handleBatchSetAlias(request, env, userId) {
  const { aliases } = await request.json();
  if (!Array.isArray(aliases)) return jsonResponse({ error: "Invalid alias list" }, 400);

  const token = await getActiveToken(env, userId);
  if (!token) return jsonResponse({ error: "No active token" }, 404);

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
      if (!response.ok) throw new Error(`${response.status}`);
      results.push({ alias: item.alias, success: true });
    } catch (err) {
      results.push({ alias: item.alias, error: err.message });
    }
  }
  return jsonResponse({ results });
}

// -----------------------------------------------------------------
// 內部輔助函數 (Internal Helpers)
// -----------------------------------------------------------------

/**
 * getActiveToken
 * 取得當前用戶啟用的 Token (封裝重複邏輯)
 */
async function getActiveToken(env, userId) {
  return getCurrentAccessToken(env, userId);
}

async function handleAddMenus(add, token, results) {
  for (const item of add) {
    try {
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

      if (!res.ok) throw new Error(`Add Failed: ${res.status}`);

      const { richMenuId } = await res.json();

      if (item.imageFile) {
        const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": item.imageFile.type || "image/jpeg"
          },
          body: await item.imageFile.arrayBuffer()
        });
        if (!uploadRes.ok) throw new Error(`Upload Failed: ${uploadRes.status}`);
      }

      if (item.alias) {
        await fetch("https://api.line.me/v2/bot/richmenu/alias", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ richMenuAliasId: item.alias, richMenuId })
        });
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
      // 嘗試刪除別名
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

      const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error("Delete Failed");
      results.removed.push(richMenuId);
    } catch (err) {
      results.errors.push({ richMenuId, error: err.message });
    }
  }
}

async function handleSetDefaultRichMenu(setDefault, token, results) {
  if (!setDefault?.richMenuId) return;

  try {
    const res = await fetch("https://api.line.me/v2/bot/user/all/richmenu", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ richMenuId: setDefault.richMenuId })
    });
    if (!res.ok) throw new Error("SetDefault Failed");
    results.setDefault = setDefault;
  } catch (err) {
    results.errors.push({ richMenuId: setDefault.richMenuId, error: err.message });
  }
}

/**
 * route
 * Richmenu 模組路由
 */
export function route(request, env, userId, pathname) {
  if (pathname === "/richmenu/list") return handleGetRichMenuList(env, userId);
  if (pathname === "/richmenu/default") return handleGetDefaultRichMenuId(env, userId);
  if (pathname === "/alias/list") return handleGetAliasList(env, userId);
  if (pathname === "/alias/batch") return handleBatchSetAlias(request, env, userId);

  const matchedImage = pathname.match(/^\/richmenu\/image\/(.+)$/);
  if (matchedImage) return handleGetRichMenuImage(env, userId, matchedImage[1]);

  const matchedMeta = pathname.match(/^\/richmenu\/metadata\/(.+)$/);
  if (matchedMeta) return handleGetRichMenuMetadata(env, userId, matchedMeta[1]);

  if (pathname === "/richmenu/sync") return handleSyncRichmenus(request, env, userId);

  return jsonResponse({ success: false, error: "Invalid richmenu route" }, 404);
}