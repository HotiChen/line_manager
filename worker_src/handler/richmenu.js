import { jsonResponse, getCorsHeaders } from "../lib/utils.js";
import { getAccessTokenForProject, getCurrentAccessToken } from "../lib/token_store.js";

// LINE 的硬上限。超過這些值 LINE 會回 400，與其浪費一次往返不如先擋。
const CHAT_BAR_TEXT_MAX = 14;
const AREAS_MAX = 20;

const LINE_API = "https://api.line.me/v2/bot";
const LINE_DATA_API = "https://api-data.line.me/v2/bot";

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
      fetch(`${LINE_API}/richmenu/list`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      fetch(`${LINE_API}/richmenu/alias/list`, {
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
 * Why (為什麼帶 request):
 * - 縮圖是二進位回應，不走 jsonResponse，CORS header 得自己帶。
 *   原本寫死 `*`，等於對任何站台開放本帳號的選單圖；改走 getCorsHeaders
 *   與其他端點共用同一條 fail-closed 規則（CLAUDE.md 安全約定）。
 *
 * Pre-conditions: richMenuId 必須有效
 * Post-conditions: 回傳 image/png 二進制數據
 */
export async function handleGetRichMenuImage(env, userId, richMenuId, request = null) {
  if (!env || !userId || !richMenuId) return jsonResponse({ error: "Missing required parameters" }, 400, request, env);

  const token = await getActiveToken(env, userId);
  if (!token) return jsonResponse({ error: "No active token" }, 404, request, env);

  const response = await fetch(`${LINE_DATA_API}/richmenu/${richMenuId}/content`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "image/png" },
    cf: { cacheTtl: 0 }
  });

  if (!response.ok) {
    return jsonResponse(
      { error: `Failed to fetch Rich Menu image (status: ${response.status})` },
      response.status,
      request,
      env
    );
  }

  return new Response(await response.arrayBuffer(), {
    headers: {
      "Content-Type": "image/png",
      ...getCorsHeaders(request, env)
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

  const response = await fetch(`${LINE_API}/richmenu/${richMenuId}`, {
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

  const response = await fetch(`${LINE_API}/user/all/richmenu`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) return jsonResponse({ error: "Failed to fetch Default Richmenu" }, response.status);

  const data = await response.json();
  return jsonResponse({ richMenuId: data.richMenuId });
}

/**
 * handleSyncRichmenus
 * 同步 Richmenus (支援新增、編輯、刪除、設定預設)
 *
 * Why (為什麼是循序而非 Promise.all):
 * - 四種操作彼此相依：剛新增的選單要能被設為預設、編輯會刪掉舊 ID 而刪除清單
 *   可能也提到同一個 ID。併發執行時「設為預設」可能在「新增」拿到 ID 之前就跑完，
 *   這正是原本「同步謊報成功」的來源之一。
 * - 順序固定為 add → update → setDefault → remove。
 *
 * Pre-conditions: 支援 multipart/form-data 或 JSON payload
 * Post-conditions: 執行批次操作並回傳結果報告
 */
export async function handleSyncRichmenus(request, env, userId) {
  if (!request || !env || !userId) return jsonResponse({ error: "Missing required parameters" }, 400);

  try {
    const token = await getActiveToken(env, userId);
    if (!token) return jsonResponse({ error: "No active token" }, 404);

    const payload = await parseSyncPayload(request);
    const { add = [], update = [], remove = [], setDefault = null } = payload;
    const results = { added: [], updated: [], removed: [], errors: [], setDefault: null };

    await handleAddMenus(add, token, results);
    await handleUpdateMenus(update, token, results);
    await handleSetDefaultRichMenu(setDefault, token, results);
    await handleRemoveMenus(remove, token, results);

    return jsonResponse(results);
  } catch (err) {
    console.error("[handleSyncRichmenus] ❌ 發生錯誤:", err.message);
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * parseSyncPayload
 * multipart 一次只帶一個選單（因為帶著圖片檔），JSON 則可帶整批。
 *
 * multipart 欄位 `op` 決定這個選單是新增還是編輯：
 *   op=add（預設）→ 進 add
 *   op=update      → 進 update，另需 richMenuId 指明要取代哪一個舊選單
 */
async function parseSyncPayload(request) {
  const contentType = request.headers.get("content-type") || "";

  if (!contentType.includes("multipart/form-data")) {
    return await request.json();
  }

  const form = await request.formData();
  const item = {
    name: form.get("name"),
    diamention: safeJsonParse(form.get("diamention"), []),
    areas: safeJsonParse(form.get("areas"), []),
    alias: form.get("alias"),
    chatBarText: form.get("chatBarText"),
    selected: form.get("selected") === "true",
    imageFile: form.get("imageFile") || null
  };

  if (form.get("op") === "update") {
    item.richMenuId = form.get("richMenuId");
    return { add: [], update: [item], remove: [], setDefault: null };
  }

  return { add: [item], update: [], remove: [], setDefault: null };
}

function safeJsonParse(value, fallback) {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
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
    const response = await fetch(`${LINE_API}/richmenu/alias/list`, {
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
      const response = await fetch(`${LINE_API}/richmenu/alias`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(item)
      });
      if (!response.ok) throw await lineError(response, "Set alias failed");
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

/**
 * lineError
 * 把 LINE 的錯誤回應轉成帶有原文的 Error。
 *
 * Why: 原本只留 `Add Failed: 400`，使用者看不出是尺寸不對、別名重複還是 token 失效。
 * LINE 的 body 幾乎總是說得很清楚，丟掉它等於把唯一的線索丟掉。
 */
async function lineError(response, prefix) {
  let detail;
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    detail = "";
  }
  return new Error(detail ? `${prefix} (${response.status}): ${detail}` : `${prefix} (${response.status})`);
}

/**
 * validateMenuShape
 * 在送出前擋掉 LINE 一定會拒絕的輸入。
 */
function validateMenuShape(item) {
  const chatBarText = item.chatBarText || "選單";
  if ([...chatBarText].length > CHAT_BAR_TEXT_MAX) {
    throw new Error(`chatBarText 超過 ${CHAT_BAR_TEXT_MAX} 字上限（目前 ${[...chatBarText].length} 字）`);
  }

  const areas = item.areas || [];
  if (areas.length > AREAS_MAX) {
    throw new Error(`區域數量超過 ${AREAS_MAX} 個上限（目前 ${areas.length} 個）`);
  }

  const [width, height] = item.diamention || [];
  if (!width || !height) {
    throw new Error("缺少選單尺寸 (diamention)");
  }
}

/** 建立一個 Rich Menu，回傳新的 richMenuId */
async function createRichMenu(item, token) {
  const res = await fetch(`${LINE_API}/richmenu`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: item.name,
      size: { width: item.diamention[0], height: item.diamention[1] },
      selected: item.selected === true,
      chatBarText: item.chatBarText || "選單",
      areas: item.areas || []
    })
  });

  if (!res.ok) throw await lineError(res, "建立選單失敗");

  const { richMenuId } = await res.json();
  if (!richMenuId) throw new Error("建立選單失敗：LINE 沒有回傳 richMenuId");
  return richMenuId;
}

/** 上傳圖片內容到指定選單 */
async function uploadRichMenuImage(richMenuId, imageFile, token) {
  const res = await fetch(`${LINE_DATA_API}/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": imageFile.type || "image/jpeg"
    },
    body: await imageFile.arrayBuffer()
  });
  if (!res.ok) throw await lineError(res, "上傳選單圖片失敗");
}

/** 把舊選單的圖片原封不動搬到新選單（編輯時沒換圖的情況） */
async function copyRichMenuImage(fromRichMenuId, toRichMenuId, token) {
  const getRes = await fetch(`${LINE_DATA_API}/richmenu/${fromRichMenuId}/content`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "image/png" }
  });
  if (!getRes.ok) throw await lineError(getRes, "讀取原選單圖片失敗");

  const contentType = getRes.headers.get("content-type") || "image/png";
  const bytes = await getRes.arrayBuffer();

  const putRes = await fetch(`${LINE_DATA_API}/richmenu/${toRichMenuId}/content`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": contentType
    },
    body: bytes
  });
  if (!putRes.ok) throw await lineError(putRes, "搬移選單圖片失敗");
}

/** 盡力刪除一個選單；清理路徑上的失敗只記 log，不要蓋掉原始錯誤 */
async function deleteRichMenuQuietly(richMenuId, token) {
  try {
    await fetch(`${LINE_API}/richmenu/${richMenuId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    console.error(`[richmenu] 清理 ${richMenuId} 失敗:`, err.message);
  }
}

async function fetchAliasList(token) {
  const res = await fetch(`${LINE_API}/richmenu/alias/list`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw await lineError(res, "讀取別名列表失敗");
  const { aliases = [] } = await res.json();
  return aliases;
}

/**
 * repointAlias
 * 別名已存在就改指向（LINE 有 update alias API），不存在就新建。
 */
async function repointAlias(aliasId, richMenuId, token, existingAliases) {
  const exists = existingAliases.some(a => a.richMenuAliasId === aliasId);

  const url = exists
    ? `${LINE_API}/richmenu/alias/${encodeURIComponent(aliasId)}`
    : `${LINE_API}/richmenu/alias`;

  const body = exists
    ? { richMenuId }
    : { richMenuAliasId: aliasId, richMenuId };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw await lineError(res, exists ? "更新別名失敗" : "建立別名失敗");
}

async function setDefaultRichMenu(richMenuId, token) {
  const res = await fetch(`${LINE_API}/user/all/richmenu`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ richMenuId })
  });
  if (!res.ok) throw await lineError(res, "設定預設選單失敗");
}

async function getDefaultRichMenuId(token) {
  try {
    const res = await fetch(`${LINE_API}/user/all/richmenu`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    // 沒設過預設選單時 LINE 回 404，這不是錯誤
    if (!res.ok) return null;
    const data = await res.json();
    return data.richMenuId || null;
  } catch {
    return null;
  }
}

/**
 * handleAddMenus
 *
 * Why (為什麼每一步失敗都要回頭刪):
 * - LINE 的選單在「建立」與「上傳圖片」之間是半成品：沒有圖的選單無法使用，
 *   但照樣佔用帳號的選單名額，而且使用者在後台看不到它。原本的程式碼在圖片
 *   或別名失敗時直接 throw，那個半成品就永遠留在 LINE 上。
 */
async function handleAddMenus(add, token, results) {
  for (const item of add) {
    let createdId = null;
    try {
      validateMenuShape(item);

      createdId = await createRichMenu(item, token);

      if (item.imageFile) {
        await uploadRichMenuImage(createdId, item.imageFile, token);
      }

      if (item.alias) {
        const existing = await fetchAliasList(token);
        await repointAlias(item.alias, createdId, token, existing);
      }

      results.added.push({ name: item.name, richMenuId: createdId });
    } catch (err) {
      if (createdId) await deleteRichMenuQuietly(createdId, token);
      results.errors.push({ name: item.name, error: err.message });
    }
  }
}

/**
 * handleUpdateMenus
 *
 * Why (為什麼是「建新再刪舊」):
 * - LINE 沒有修改 Rich Menu 的 API。要改名稱、區域或圖片，唯一的辦法是建立
 *   一個新選單、把別名與預設設定指過去，再刪掉舊的。原本的程式碼只把選單
 *   標成 isUpdated 就送出，後端又把 update 解構掉，所以「編輯」實際上什麼
 *   都沒做 —— 畫面卻顯示成功。
 * - 整個流程中途失敗時，必須刪掉剛建立的新選單並保留舊的：使用者寧可編輯
 *   沒生效，也不要兩個半成品。
 */
async function handleUpdateMenus(update, token, results) {
  if (!Array.isArray(update) || update.length === 0) return;

  const currentDefaultId = await getDefaultRichMenuId(token);

  for (const item of update) {
    const oldRichMenuId = item.richMenuId;
    let newRichMenuId = null;

    try {
      if (!oldRichMenuId) throw new Error("缺少要取代的 richMenuId");
      validateMenuShape(item);

      // 1. 建立新選單
      newRichMenuId = await createRichMenu(item, token);

      // 2. 圖片：有新圖就用新圖，沒有就把舊圖搬過去
      if (item.imageFile) {
        await uploadRichMenuImage(newRichMenuId, item.imageFile, token);
      } else {
        await copyRichMenuImage(oldRichMenuId, newRichMenuId, token);
      }

      // 3. 別名指到新選單
      if (item.alias) {
        const existing = await fetchAliasList(token);
        await repointAlias(item.alias, newRichMenuId, token, existing);
      }

      // 4. 舊的是預設選單的話，由新的接手
      if (currentDefaultId && currentDefaultId === oldRichMenuId) {
        await setDefaultRichMenu(newRichMenuId, token);
        results.setDefault = { name: item.name, richMenuId: newRichMenuId };
      }

      // 5. 一切就緒才刪舊的
      const delRes = await fetch(`${LINE_API}/richmenu/${oldRichMenuId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!delRes.ok) throw await lineError(delRes, "刪除舊選單失敗");

      results.updated.push({
        name: item.name,
        richMenuId: newRichMenuId,
        previousRichMenuId: oldRichMenuId
      });
    } catch (err) {
      if (newRichMenuId) await deleteRichMenuQuietly(newRichMenuId, token);
      results.errors.push({ name: item.name, richMenuId: oldRichMenuId, error: err.message });
    }
  }
}

async function handleRemoveMenus(remove, token, results) {
  for (const richMenuId of remove) {
    try {
      // 先清掉指向它的別名，否則別名會變成懸空的
      const aliasListRes = await fetch(`${LINE_API}/richmenu/alias/list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (aliasListRes.ok) {
        const { aliases = [] } = await aliasListRes.json();
        const myAliases = aliases.filter(a => a.richMenuId === richMenuId);
        for (const a of myAliases) {
          await fetch(`${LINE_API}/richmenu/alias/${encodeURIComponent(a.richMenuAliasId)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
          });
        }
      }

      const res = await fetch(`${LINE_API}/richmenu/${richMenuId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw await lineError(res, "刪除選單失敗");
      results.removed.push(richMenuId);
    } catch (err) {
      results.errors.push({ richMenuId, error: err.message });
    }
  }
}

/**
 * handleSetDefaultRichMenu
 *
 * Why (為什麼要用 name 回查):
 * - 前端把「剛新增、還沒有 ID」的選單設為預設是很常見的動作。原本的程式碼
 *   看到空的 richMenuId 就直接 return，前端沒有任何訊號，於是顯示「✅ 預設
 *   選單已設定」—— 實際上什麼都沒發生。
 * - 新增已在本次同步中完成，results.added 裡就有剛拿到的 ID，用名稱對回去即可。
 */
async function handleSetDefaultRichMenu(setDefault, token, results) {
  if (!setDefault) return;

  const resolvedId = setDefault.richMenuId
    || results.added.find(m => m.name === setDefault.name)?.richMenuId
    || results.updated.find(m => m.name === setDefault.name)?.richMenuId;

  if (!resolvedId) {
    results.errors.push({
      name: setDefault.name,
      error: `找不到「${setDefault.name || "(未命名)"}」的 richMenuId，無法設為預設`
    });
    return;
  }

  try {
    await setDefaultRichMenu(resolvedId, token);
    results.setDefault = { name: setDefault.name, richMenuId: resolvedId };
  } catch (err) {
    results.errors.push({ name: setDefault.name, richMenuId: resolvedId, error: err.message });
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
  if (matchedImage) return handleGetRichMenuImage(env, userId, matchedImage[1], request);

  const matchedMeta = pathname.match(/^\/richmenu\/metadata\/(.+)$/);
  if (matchedMeta) return handleGetRichMenuMetadata(env, userId, matchedMeta[1]);

  if (pathname === "/richmenu/sync") return handleSyncRichmenus(request, env, userId);

  return jsonResponse({ success: false, error: "Invalid richmenu route" }, 404);
}
