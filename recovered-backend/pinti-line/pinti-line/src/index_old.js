export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      let form = null;
  
      // 🔹 CORS 預檢請求
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,  // ✅ 使用 204 No Content，避免瀏覽器誤判
          headers: getCorsHeaders(),
        });
      }
  
  
  
      // 🔹 嘗試從 header 取得 userId
      let userId = request.headers.get("X-User-Id");
  
      // 🔸 如果沒帶在 header，且是 multipart/form-data，改從 formData 裡撈
      if (!userId && request.method === "POST" && request.headers.get("content-type")?.includes("multipart/form-data")) {
        try {
          form = await request.formData();
          userId = form.get("userId");
          // 把解析好的 form 傳下去使用（optional 優化：可存在 request 上）
          request.formDataCache = form;
        } catch (e) {
          return jsonResponse({ error: "Failed to parse FormData" }, 400);
        }
      }
  
  
  
  
  
  
      // // 🔹 取得 `userId`（前端應該傳 `X-User-Id`）
      // const userId = request.headers.get("X-User-Id");
      // if (!userId) return jsonResponse({ error: "Missing User ID" }, 401);
  
      // 🔹 API 路由
      // line token 用
      if (url.pathname === "/token/register" && request.method === "POST") {
        return await handleRegisterAccessToken(request, env, userId);
      }
  
      if (url.pathname === "/token/set" && request.method === "POST") {
        return await handleSetCurrentToken(request, env, userId);
      }
  
      if (url.pathname === "/token/delete" && request.method === "DELETE") {
        return await handleDeleteAccessToken(request, env, userId);
      }
  
      if (url.pathname === "/token/current" && request.method === "GET") {
        return await handleGetCurrentToken(env, userId);
      }
  
      //richmenu 用
      if (url.pathname === "/richmenu/list" && request.method === "GET") {
        return await handleGetRichMenuList(env, userId);
      }
  
      if (url.pathname.startsWith("/richmenu/image/")) {
        const richMenuId = url.pathname.split("/").pop();
        return await handleGetRichMenuImage(env, userId, richMenuId);
      }
  
      // 取得 UserID 對應的所有專案
      if (url.pathname === "/token/list" && request.method === "GET") {
        return await handleListUserProjects(env, userId);
      }
      
      // 取得 Richmenu metadata
      if (url.pathname.startsWith("/richmenu/metadata/")) {
        const richMenuId = url.pathname.split("/").pop();
        return await handleGetRichMenuMetadata(env, userId, richMenuId);
      }
  
      if (url.pathname === "/richmenu/sync" && request.method === "POST") {
        return await handleSyncRichmenus(request, env, userId, form);
      }
  
      if (url.pathname === "/alias/batch" && request.method === "POST") {
        return await handleBatchSetAlias(request, env, userId);
      }
  
      if (url.pathname === "/alias/list" && request.method === "GET") {
        return await handleGetAliasList(env, userId);
      }
  
      // 7️⃣ 取得 Default Richmenu ID
      if (url.pathname === "/richmenu/default" && request.method === "GET") {
        return await handleGetDefaultRichMenuId(env, userId);
      }
  
      //profile 用
      if (url.pathname === "/profile/register" && request.method === "POST") {
        return await handleRegisterUserProfile(request, env, userId);
      }
  
      if (url.pathname === "/profile/check" && request.method === "GET") {
        return await handleCheckUserProfile(env, userId);
      }
  
      //flex msg 用
      if (url.pathname === "/flex/save" && request.method === "POST") {
        return await handleSaveFlexMessage(request, env, userId);
      }
  
      if (url.pathname === "/flex/list" && request.method === "GET") {
        return await handleListFlexMessages(env, userId);
      }
  
      if (url.pathname === "/flex/delete" && request.method === "POST") {
        return await handleDeleteFlexMessage(request, env, userId);
      }
  
      //imagemap 用
      if (url.pathname === "/imagemap/save" && request.method === "POST") {
        return await handleSaveImagemapData(request, env, userId);
      }
  
      if (url.pathname === "/imagemap/list" && request.method === "GET") {
        return await handleListImagemaps(env, userId);
      }
  
  
      return jsonResponse({ error: "Not Found" }, 404);
    }
  };
  
  // ✅ 1️⃣ 註冊 Access Token
  async function handleRegisterAccessToken(request, env, userId) {
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
  
  // ✅ 2️⃣ 設定當前使用的 Access Token
  async function handleSetCurrentToken(request, env, userId) {
    const { project } = await request.json();
    let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
  
    if (!accessTokens[project]) return jsonResponse({ error: "Project not found" }, 404);
  
    await env.KV_LINE_STORAGE.put(`current_token_${userId}`, project);
    return jsonResponse({ success: `Current token set to ${project}` });
  }
  
  // ✅ 3️⃣ 刪除 Access Token
  async function handleDeleteAccessToken(request, env, userId) {
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
  async function handleGetCurrentToken(env, userId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    return jsonResponse({ project, token: accessTokens[project] });
  }
  
  
  // ✅ 取得 UserID 的所有專案
  async function handleListUserProjects(env, userId) {
    console.log("[DEBUG] env keys:", Object.keys(env));
    console.log("[handleListUserProjects] KV_LINE_STORAGE =", typeof env.KV_LINE_STORAGE);
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    console.log("[handleListUserProjects] 取得 accessTokens =", accessTokens);
    //const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    return new Response(JSON.stringify(accessTokens), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
  
  // ✅ 5️⃣ 取得 Richmenu 列表
  async function handleGetRichMenuList(env, userId) {
    console.log(env);
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    let accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const token = accessTokens[project];
  
  
    console.log(`📌 取得 access token for ${userId},的 ${project}  token=${token}`);
  
    if (!token) return jsonResponse({ error: "No token found for current project" }, 404);
  
    const response = await fetch("https://api.line.me/v2/bot/richmenu/list", {
      headers: { Authorization: `Bearer ${token}` }
    });
  
    if (!response.ok) return jsonResponse({ error: "Failed to fetch Rich Menu list" }, response.status);
  
    return jsonResponse(await response.json());
  }
  
  // ✅ 6️⃣ 取得 Richmenu 縮圖
  async function handleGetRichMenuImage(env, userId, richMenuId) {
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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id",
      "Access-Control-Max-Age": "86400" // ✅ 可選：快取預檢結果，減少預檢次數
    };
  }
  
  
  
  // ✅ 取得 Richmenu metadata
  async function handleGetRichMenuMetadata(env, userId, richMenuId) {
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
  async function handleGetDefaultRichMenuId(env, userId) {
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
  
  
  async function handleAddMenus(add, token, results) {
    for (const item of add) {
      try {
        console.log("[handleAddMenus] 處理:", item.name);
  
        // 1️⃣ 建立 Richmenu
        const res = await fetch("https://api.line.me/v2/bot/richmenu", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: item.name,
            size: {
              width: item.diamention[0],
              height: item.diamention[1]
            },
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
        console.log("[新增成功] richMenuId =", richMenuId);
  
        // // 2️⃣ 圖片上傳
        // if (item.imageBase64) {
        //   try {
        //     const matches = item.imageBase64.match(/^data:(image\/\w+);base64,/);
        //     const mimeType = matches ? matches[1] : "image/png";
        //     const base64Data = item.imageBase64.replace(/^data:image\/\w+;base64,/, "");
        //     const imageBuffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
  
        //     console.log(`[圖片上傳中] ${item.name}, MIME: ${mimeType}, 長度: ${imageBuffer.length}`);
  
        //     const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
        //       method: "POST",
        //       headers: {
        //         "Authorization": `Bearer ${token}`,
        //         "Content-Type": mimeType
        //       },
        //       body: imageBuffer
        //     });
  
        //     if (!uploadRes.ok) {
        //       const uploadError = await uploadRes.text();
        //       throw new Error(`[圖片上傳失敗] ${uploadRes.status} - ${uploadError}`);
        //     }
  
        //     console.log(`[圖片上傳成功] richMenuId: ${richMenuId}`);
        //   } catch (imgErr) {
        //     console.error(`[handleAddMenus] ❌ 圖片上傳失敗 (${item.name}):`, imgErr.message);
        //     results.errors.push({ name: item.name, error: imgErr.message });
        //     continue; // 🛑 圖片失敗就跳過這筆
        //   }
        // } else {
        //   console.warn("[圖片] 未提供 imageBase64");
        // }
  
  // 2️⃣ 圖片上傳
        if (item.imageFile) {
          try {
            const imageBlob = item.imageFile;
            const mimeType = imageBlob.type || "image/jpeg"; // 預設為 jpeg
            const arrayBuffer = await imageBlob.arrayBuffer();
            const imageBuffer = new Uint8Array(arrayBuffer);
  
            console.log(`[圖片上傳中] ${item.name}, MIME: ${mimeType}, 長度: ${imageBuffer.length}`);
  
            const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": mimeType
              },
              body: imageBuffer
            });
  
            if (!uploadRes.ok) {
              const uploadError = await uploadRes.text();
              throw new Error(`[圖片上傳失敗] ${uploadRes.status} - ${uploadError}`);
            }
  
            console.log(`[圖片上傳成功] richMenuId: ${richMenuId}`);
          } catch (imgErr) {
            console.error(`[handleAddMenus] ❌ 圖片上傳失敗 (${item.name}):`, imgErr.message);
            results.errors.push({ name: item.name, error: imgErr.message });
            continue; // 🛑 圖片失敗就跳過這筆
          }
        } else {
          console.warn("[圖片] 未提供 imageFile");
        }
  
  
        // 3️⃣ 設定 alias（可選）
        if (item.alias) {
          try {
            console.log(`[設定 alias] ${item.alias} → ${richMenuId}`);
            const aliasRes = await fetch("https://api.line.me/v2/bot/richmenu/alias", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                richMenuAliasId: item.alias,
                richMenuId: richMenuId
              })
            });
  
            if (!aliasRes.ok) {
              const aliasText = await aliasRes.text();
              throw new Error(`[設定 alias 失敗] ${aliasRes.status} - ${aliasText}`);
            }
          } catch (aliasErr) {
            console.error(`[handleAddMenus] ❌ alias 設定失敗 (${item.alias}):`, aliasErr.message);
            results.errors.push({ name: item.name, alias: item.alias, error: aliasErr.message });
            continue; // 🛑 alias 失敗也跳過這筆，避免前端以為成功
          }
        }
  
        // ✅ 最後成功才加入 results.added
        results.added.push({
          name: item.name,
          richMenuId,
          alias: item.alias || "",
          imageID: richMenuId
        });
  
      } catch (err) {
        console.error("[handleAddMenus] ❌ 建立 Richmenu 發生錯誤:", err.message);
        results.errors.push({ name: item.name, error: err.message });
      }
    }
  }
  
  
  async function handleRemoveMenus(remove, token, results) {
    for (const richMenuId of remove) {
      try {
        // 1️⃣ 查詢目前這個 richMenuId 綁定了哪些 alias
        const aliasListRes = await fetch("https://api.line.me/v2/bot/richmenu/alias/list", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        });
  
        if (!aliasListRes.ok) throw new Error("取得 alias list 失敗");
  
        const aliasList = await aliasListRes.json();
  
        // 2️⃣ 過濾出指向這個 richMenuId 的 alias
        const aliasesToDelete = (aliasList.aliases || []).filter(alias => alias.richMenuId === richMenuId);
  
        // 3️⃣ 依序刪除這些 alias
        for (const alias of aliasesToDelete) {
          const deleteAliasRes = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${alias.richMenuAliasId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
          });
  
          if (!deleteAliasRes.ok) {
            throw new Error(`刪除 alias 失敗：${alias.richMenuId}`);
          } else {
            console.log(`✅ 已刪除 alias：${alias.richMenuId}`);
          }
        }
  
        // 4️⃣ 接著刪除 Richmenu 本體
        const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` }
        });
  
        if (!res.ok) throw new Error("刪除 Richmenu 失敗");
  
        results.removed.push(richMenuId);
      } catch (err) {
        results.errors.push({ richMenuId, error: err.message });
      }
    }
  }
  
  // async function handleRemoveMenus(remove, token, results) {
  //   for (const richMenuId of remove) {
  //     try {
  //       const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
  //         method: "DELETE",
  //         headers: { Authorization: `Bearer ${token}` }
  //       });
  //       if (!res.ok) throw new Error("刪除失敗");
  //       results.removed.push(richMenuId);
  //     } catch (err) {
  //       results.errors.push({ richMenuId, error: err.message });
  //     }
  //   }
  // }
  
  function handleUpdateMenus(update, results) {
    for (const item of update) {
      results.updated.push({ name: item.name, message: "請使用 delete + add 模式" });
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
  
        if (!res.ok) throw new Error("設定 Default Richmenu 失敗");
  
        results.setDefault = {
          name: setDefault.name,
          richMenuId: setDefault.richMenuId
        };
      } catch (err) {
        results.errors.push({
          richMenuId: setDefault.richMenuId,
          error: "設定 default richmenu 失敗: " + err.message
        });
      }
    }
  }
  
  async function handleSyncRichmenus(request, env, userId, form = null) {
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
  
  async function handleBatchSetAlias(request, env, userId) {
    const { aliases } = await request.json();
  
    if (!Array.isArray(aliases)) {
      return jsonResponse({ error: "Invalid alias list" }, 400);
    }
  
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const token = accessTokens[project];
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
  
  async function handleGetAliasList(env, userId) {
    const project = await env.KV_LINE_STORAGE.get(`current_token_${userId}`);
    if (!project) return jsonResponse({ error: "No current project set" }, 404);
  
    const accessTokens = await env.KV_LINE_STORAGE.get(`access_tokens_${userId}`, { type: "json" }) || {};
    const token = accessTokens[project];
    if (!token) return jsonResponse({ error: "No token found for current project" }, 404);
  
    try {
      const response = await fetch("https://api.line.me/v2/bot/richmenu/alias/list", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
  
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[getAliasList] LINE API 錯誤 ${response.status} - ${errorText}`);
      }
  
      const data = await response.json();
      return jsonResponse(data);
    } catch (err) {
      console.error("[getAliasList] ❌ 錯誤：", err);
      return jsonResponse({ error: err.message }, 500);
    }
  }
  
  async function handleRegisterUserProfile(request, env, userId) {
    const { userName, userEmail, lineDisplayName } = await request.json();
    if (!userName || !userEmail) {
      return jsonResponse({ error: "Missing fields" }, 400);
    }
  
    const profile = { userName, userEmail, lineDisplayName, createdAt: Date.now() };
    await env.KV_LINE_STORAGE.put(`profile_${userId}`, JSON.stringify(profile));
  
    return jsonResponse({ success: true, userId });
  }
  
  async function handleCheckUserProfile(env, userId) {
    const profileRaw = await env.KV_LINE_STORAGE.get(`profile_${userId}`);
    if (!profileRaw) {
      return jsonResponse({ exists: false });
    }
  
    try {
      const profile = JSON.parse(profileRaw);
      return jsonResponse({ exists: true, profile });
    } catch (err) {
      console.error("[handleCheckUserProfile] JSON 解析錯誤:", err);
      return jsonResponse({ exists: false, error: "Invalid profile data" }, 500);
    }
  }
  
  async function handleSaveFlexMessage(request, env, userId) {
    const { name, content } = await request.json();
    if (!name || !content) return jsonResponse({ error: "Missing name or content" }, 400);
  
    const key = `flex_${userId}_${name}`;
  
    const exists = await env.KV_LINE_STORAGE.get(key);
    await env.KV_LINE_STORAGE.put(key, JSON.stringify(content));
  
    const message = exists ? "已覆蓋原有內容" : "已建立新檔案";
    return jsonResponse({ success: true, name, message });
  }
  
  async function handleListFlexMessages(env, userId) {
    const list = await env.KV_LINE_STORAGE.list({ prefix: `flex_${userId}_` });
    const keys = list.keys.map(k => k.name.replace(`flex_${userId}_`, ""));
    return jsonResponse({ messages: keys });
  }
  
  async function handleDeleteFlexMessage(request, env, userId) {
    const { name } = await request.json();
    if (!name) return jsonResponse({ error: "Missing name" }, 400);
  
    const key = `flex_${userId}_${name}`;
    await env.KV_LINE_STORAGE.delete(key);
  
    return jsonResponse({ success: true, name });
  }
  
  async function handleSaveImagemapData(request, env, userId) {
    const { imagemaps } = await request.json();
    if (!Array.isArray(imagemaps)) return jsonResponse({ error: "Invalid imagemap data" }, 400);
  
    await env.KV_LINE_STORAGE.put(`imagemap_${userId}`, JSON.stringify(imagemaps));
    return jsonResponse({ success: true, message: `已儲存 ${imagemaps.length} 筆 ImageMap` });
  }
  
  async function handleListImagemaps(env, userId) {
    try {
      const key = `imagemap_${userId}`;
      const raw = await env.KV_LINE_STORAGE.get(key);
      if (!raw) return jsonResponse({ imagemaps: [] });
      return jsonResponse({ imagemaps: JSON.parse(raw) });
    } catch (err) {
      console.error("[handleListImagemaps] ❌", err);
      return jsonResponse({ error: err.message }, 500);
    }
  }