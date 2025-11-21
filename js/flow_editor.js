import { showLoader, hideLoader } from './shared/loader.js';
import {
  fetchMessageListByType,
  fetchKeywordReplies,
  fetchWelcomeMessage,
  waitForGlobalVar,
  fetchRichMenuDetails
} from "../helper/message.helper.js?v=1763312843";

// 輔助函式：動態載入腳本
async function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => {
      console.log(`flow_editor.js: Script loaded successfully: ${src}`);
      resolve();
    };
    script.onerror = () => {
      console.error(`flow_editor.js: Failed to load script: ${src}`);
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(script);
  });
}

export async function pageInit(pageData) {
  try {
    
    const userId = pageData.userId;
    const id = document.getElementById("drawflow");
    if (!id) {
      console.error("Drawflow container not found!");
      return;
    }
    // --- 動態載入 Drawflow 腳本 ---
    console.log("flow_editor.js: Dynamically loading Drawflow script...");
    try {
      await loadScript("https://cdn.jsdelivr.net/gh/jerosoler/Drawflow@0.0.59/dist/drawflow.min.js");
      console.log("flow_editor.js: Drawflow script loaded dynamically.");
    } catch (e) {
      console.error("flow_editor.js: Error during dynamic script loading:", e);
      return; // 如果腳本載入失敗，則停止執行
    }

    await waitForGlobalVar('Drawflow');
    const editor = new window.Drawflow(id);
    editor.reroute = true;
    editor.start();
    console.log("Drawflow editor initialized.");

    if (!userId) {
      console.error("User ID not found. Cannot fetch data.");
      return;
    }

    // --- 變數與輔助函式宣告 (移至此處以擴大作用域) ---
    const nodeDataMap = new Map(); // Stores the full data object for each Drawflow node ID

    const createNodeContent = (type, item) => {
      let title = "";
      let description = "";
      let icon = "";

      switch (type) {
        case "richmenu": { // Use block scope for constants
          // Fallback for incomplete data
          if (!item.imageUrl || !item.diamention || item.diamention.length < 2 || !item.areas) {
              const fallbackStyle = `
                  width: 250px; 
                  background: #f7f9fb; 
                  border: 1px solid #e0e3e8; 
                  border-radius: 8px; 
                  padding: 10px;
                  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
              `;
              const title = item.name || "未命名 Richmenu";
              const description = item.alias ? `Alias: ${item.alias}` : "";
              const icon = "🖼️";
              return `<div style="${fallbackStyle}"><div style="font-size: 1.2em; font-weight: bold;">${icon} ${title}</div><div style="font-size: 0.9em; color: #6c757d;">${description}</div></div>`;
          }

          const MAX_NODE_WIDTH = 500;
          const originalWidth = item.diamention[0];
          const originalHeight = item.diamention[1];
          
          let scale = 1;
          if (originalWidth > MAX_NODE_WIDTH) {
            scale = MAX_NODE_WIDTH / originalWidth;
          }
          
          const imageWidth = originalWidth * scale;
          const imageHeight = originalHeight * scale;

          const areasHtml = item.areas.map((area, index) => {
            const bounds = area.bounds;
            const areaStyle = `
              position: absolute;
              left: ${bounds.x * scale}px;
              top: ${bounds.y * scale}px;
              width: ${bounds.width * scale}px;
              height: ${bounds.height * scale}px;
              border: 1px solid rgba(255, 0, 0, 0.7);
              background-color: rgba(255, 0, 0, 0.2);
              box-sizing: border-box;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: center;
            `;
            const actionTitle = area.action ? `Action: ${area.action.type}` : 'No action';
            const numberStyle = `color: white; font-size: 16px; font-weight: bold; text-shadow: 1px 1px 2px black;`;
            return `<div style="${areaStyle}" title="${actionTitle}"><span style="${numberStyle}">${index + 1}</span></div>`;
          }).join('');

          const imageContainerStyle = `
            position: relative;
            height: ${imageHeight}px;
            background-image: url('${item.imageUrl}');
            background-size: 100% 100%;
            background-repeat: no-repeat;
          `;

          const nodeWrapperStyle = `
            border-radius: 8px;
            background: #f7f9fb;
            border: 1px solid #e0e3e8;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
            width: ${imageWidth}px;
            overflow: hidden; /* Ensure nothing spills out */
          `;

          return `
            <div style="${nodeWrapperStyle}">
              <div style="font-weight: bold; padding: 8px; border-bottom: 1px solid #ddd;">${item.name || '未命名 Richmenu'}</div>
              <div style="${imageContainerStyle}">
                ${areasHtml}
              </div>
            </div>
          `;
        }

        case "imagemap":
          title = item.altText || "未命名 Imagemap";
          description = "";
          icon = "🗺️";
          break;

        case "flex":
          title = item.title || "未命名 Flex";
          description = item.altText || "";
          icon = "📱";
          break;

        case "keyword":
          title = `關鍵字: ${item.keyword}`;
          description = `回覆數: ${item.replies?.length || 0}`;
          icon = "🔑";
          break;

        case "welcome":
          title = "歡迎訊息";
          description = item.type ? `類型: ${item.type}` : "";
          icon = "👋";
          break;

        default:
          title = "未知類型";
          description = "";
          icon = "❓";
      }

      return `
        <div class="drawflow-node-content">
          <div style="font-size: 1.2em; font-weight: bold;">${icon} ${title}</div>
          <div style="font-size: 0.9em; color: #6c757d;">${description}</div>
        </div>
      `;
    };

    try {
      // 1. --- FETCH ALL DATA ---
      console.log("Fetching all message data for flow editor...");
      const [richmenusMinimal, imagemaps, flexMessages, keywordReplies, welcomeMessage] = await Promise.all([
          fetchMessageListByType("richmenu", userId),
          fetchMessageListByType("imagemap", userId),
          fetchMessageListByType("flex", userId),
          fetchKeywordReplies(userId),
          fetchWelcomeMessage(userId)
      ]);
      const richmenus = await Promise.all(richmenusMinimal.map(menu => fetchRichMenuDetails(menu, userId)));
      
      const allData = { richmenus, imagemaps, flexMessages, keywordReplies, welcomeMessage };
      console.log("✅ All message data fetched:", allData);

      showLoader('Building graph...');
      // --- ABSTRACTIONS FOR GRAPH LOGIC ---
      const getNodeBusinessId = (type, item) => {
          if (type === 'richmenu') return item.richMenuId || item.id;
          if (type === 'imagemap') return item.id;
          if (type === 'flex') return item.id;
          if (type === 'keyword') return item.keyword;
          if (type === 'welcome') return 'welcome_message';
          return null;
      };

      const getActionsFromItem = (type, item) => {
          if (type === 'richmenu') return item.areas?.map(a => a.action) || [];
          if (type === 'imagemap') return item.actions || [];
          if (type === 'keyword') return item.replies || [];
          if (type === 'welcome') return item.replies || [];
          if (type === 'flex') {
              const actions = [];
              const findActionsInFlex = (contents) => {
                  if (!contents) return;
                  const processContent = (content) => {
                      if (content.action) actions.push(content.action);
                      if (content.contents && Array.isArray(content.contents)) content.contents.forEach(processContent);
                      if (content.footer?.contents) content.footer.contents.forEach(processContent);
                  };
                  if (item.type === 'carousel' && Array.isArray(item.contents)) item.contents.forEach(bubble => processContent(bubble.body));
                  else if (item.type === 'bubble') processContent(item.body);
              };
              findActionsInFlex(item);
              return actions;
          }
          return [];
      };
      
      const getTargetBusinessIdFromAction = (action) => {
          if (!action) return null;
          if (action.type === 'richmenuswitch') return action.richMenuAliasId;
          if (action.type === 'message' && action.text?.startsWith('keyword:')) return action.text.substring(8);
          if (action.type === 'postback' && action.data?.startsWith('keyword:')) return action.data.substring(8);
          if (action.type === 'imagemap') return action.id;
          if (action.type === 'flex') return action.id;
          return null;
      };

      // 2. --- BUILD GRAPH AND HIERARCHY ---
      const graph = new Map(); // Map<string, Set<string>>
      const allNodeBusinessIds = new Set();
      const targetNodeBusinessIds = new Set();
      const allItemsMap = new Map(); // Map<string, {type: string, item: object}>

      const processItem = (type, item) => {
          const businessId = getNodeBusinessId(type, item);
          if (!businessId) return;
          allNodeBusinessIds.add(businessId);
          allItemsMap.set(businessId, { type, item });
          if (!graph.has(businessId)) graph.set(businessId, new Set());
          
          const actions = getActionsFromItem(type, item);
          actions.forEach(action => {
              const targetId = getTargetBusinessIdFromAction(action);
              if (targetId) {
                  graph.get(businessId).add(targetId);
                  targetNodeBusinessIds.add(targetId);
              }
          });
      };

      richmenus.forEach(item => processItem('richmenu', item));
      imagemaps.forEach(item => processItem('imagemap', item));
      flexMessages.forEach(item => processItem('flex', item));
      keywordReplies.forEach(item => processItem('keyword', item));
      if (welcomeMessage) processItem('welcome', welcomeMessage);

      const nodeLevels = new Map(); // Map<string, number>
      const rootNodes = [...allNodeBusinessIds].filter(id => !targetNodeBusinessIds.has(id));
      const queue = rootNodes.map(id => ({ id, level: 0 }));
      
      rootNodes.forEach(id => nodeLevels.set(id, 0));

      let head = 0;
      while(head < queue.length) {
          const { id, level } = queue[head++];
          const children = graph.get(id) || new Set();
          children.forEach(childId => {
              if (!nodeLevels.has(childId)) {
                  nodeLevels.set(childId, level + 1);
                  queue.push({ id: childId, level: level + 1 });
              }
          });
      }

      // 3. --- PLACE NODES AND CONNECTIONS ---
      const levelCounts = {}; // To stack nodes vertically
      const businessIdToDfId = new Map(); // Map business ID to Drawflow ID
      const HORIZONTAL_GAP = 400;
      const VERTICAL_GAP = 200;

      // Create nodes with calculated positions
      for (const businessId of allNodeBusinessIds) {
          const level = nodeLevels.get(businessId) ?? 0;
          if (levelCounts[level] === undefined) levelCounts[level] = 0;

          const { type, item } = allItemsMap.get(businessId);
          
          const numOutputs = (type === 'richmenu' && item.areas) ? item.areas.length : 1;
          const nodeHtml = createNodeContent(type, item);
          const posX = 100 + level * HORIZONTAL_GAP;
          const posY = 100 + levelCounts[level] * VERTICAL_GAP;
          
          const dfId = editor.addNode(businessId, 1, numOutputs, posX, posY, `${type}-node`, { type, data: item }, nodeHtml);
          
          businessIdToDfId.set(businessId, dfId);
          nodeDataMap.set(dfId, { type, data: item });
          levelCounts[level]++;
      }

      // Create connections
      for (const [sourceBusinessId, children] of graph.entries()) {
          const sourceDfId = businessIdToDfId.get(sourceBusinessId);
          if (!sourceDfId) continue;

          const { type, item } = allItemsMap.get(sourceBusinessId);

          if (type === 'richmenu') {
              item.areas?.forEach((area, index) => {
                  const targetBusinessId = getTargetBusinessIdFromAction(area.action);
                  const targetDfId = businessIdToDfId.get(targetBusinessId);
                  if (targetDfId) {
                      editor.addConnection(sourceDfId, targetDfId, `output_${index + 1}`, 'input_1');
                  }
              });
          } else {
              children.forEach(childBusinessId => {
                  const targetDfId = businessIdToDfId.get(childBusinessId);
                  if (targetDfId) {
                      editor.addConnection(sourceDfId, targetDfId, 'output_1', 'input_1');
                  }
              });
          }
      }

      console.log("✅ All nodes and connections drawn with tree layout.");

      // --- Event Listeners ---
      editor.on('nodeSelected', function(nodeId) {
        const nodeInfo = nodeDataMap.get(nodeId);
        if (nodeInfo) {
          const { type, data } = nodeInfo;
          let page = '';
          let idParam = '';
          switch(type) {
            case 'richmenu': page = 'richmenu'; idParam = data.richMenuId || data.id; break;
            case 'imagemap': page = 'imagemap_builder'; idParam = data.id; break;
            case 'flex': page = 'flex_builder'; idParam = data.id; break;
            case 'keyword': page = 'keyword_reply_builder'; idParam = data.keyword; break;
            case 'welcome': page = 'welcome_msg_builder'; break;
          }
          if (page) console.log(`點擊節點: ${type} - ${idParam}. 導向頁面: ${page}`);
        }
      });

      editor.on('canvasClick', function(event) {
        if (event.button === 2) { // Right-click
          event.preventDefault();
          console.log("Right-clicked on canvas. Implement context menu here.");
        }
      });

    } catch (error) {
      console.error("❌ Error fetching data or drawing flow editor:", error);
    }
  } finally {
    hideLoader();
  }
}
