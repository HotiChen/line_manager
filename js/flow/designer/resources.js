// js/flow/designer/resources.js
// Resources：選擇 Richmenu/Flex/Imagemap/Keyword 並把按鈕展開成節點
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { ApiClient as api } from '../../../helper/api.client.js';
import { showLoader, hideLoader } from '../../shared/loader.js';
import { dataLoader } from '../../flow_designer_data_loader.js';
import { NodeTypes } from '../node_types.js';

export class ResourcesMethods {
    // ========== 節點資料更新函數 ==========

    /**
     * 載入 Keyword 列表（用於自動匹配）
     */
    async loadKeywordList() {
        // 如果快取未過期（5分鐘），直接使用
        const now = Date.now();
        if (this.keywordList && this.keywordListLoadTime && (now - this.keywordListLoadTime < 5 * 60 * 1000)) {
            return this.keywordList;
        }

        try {
            const data = await api.get('/keyword/list');
            this.keywordList = data.data || [];
            this.keywordListLoadTime = now;

            return this.keywordList;
        } catch (error) {
            console.error('[Keyword] 載入失敗:', error);
            return [];
        }
    }

    /**
     * 匹配文字到 Keyword
     * @param {string} text - 要匹配的文字
     * @returns {object|null} - 匹配到的 keyword 物件，或 null
     */
    async matchKeyword(text) {
        if (!text) return null;

        const keywords = await this.loadKeywordList();
        if (!keywords || keywords.length === 0) return null;

        // 尋找匹配的 keyword
        const matched = keywords.find(kw => {
            if (kw.matchType === 'exact') {
                return kw.keyword === text;
            } else if (kw.matchType === 'contains') {
                return text.includes(kw.keyword);
            } else if (kw.matchType === 'regex') {
                try {
                    const regex = new RegExp(kw.keyword);
                    return regex.test(text);
                } catch (e) {
                    return false;
                }
            }
            return false;
        });

        return matched || null;
    }

    /**
     * 選擇 Richmenu
     */
    async selectRichmenu(nodeId) {
        const selectElement = document.getElementById('resource-select-richmenu');
        const richMenuId = selectElement.value;

        if (!richMenuId) {
            toast.warning('請先選擇一個 Richmenu');
            return;
        }

        showLoader('載入 Richmenu 資料中...');
        try {
            const details = await dataLoader.loadRichmenuDetails(richMenuId);
            if (details) {
                const node = this.nodes.find(n => n.id === nodeId);
                if (node) {
                    node.data.richmenuId = details.richMenuId;
                    node.data.name = details.name;
                    node.data.buttons = details.buttons;
                    node.data.imageUrl = details.imageUrl;
                    node.data.size = details.size;  // ✅ 儲存尺寸資訊

                    // 重新渲染節點以顯示圖片和按鈕框框
                    const nodeElement = document.getElementById(nodeId);
                    if (nodeElement) {
                        nodeElement.remove();
                        this.renderNode(node);
                    }

                    this.showNodeProperties(nodeId);
                    this.saveToLocalStorage();
                    toast.success('✅ Richmenu 已載入');
                }
            }
        } catch (error) {
            console.error('[載入 Richmenu] 錯誤:', error);
            toast.error('載入 Richmenu 失敗');
        } finally {
            hideLoader();
        }
    }

    /**
     * 自動展開 Richmenu 按鈕，創建對應的節點
     */
    async expandRichmenuButtons(richmenuNode, processedRichmenus = new Set()) {
        if (!richmenuNode.data.buttons || richmenuNode.data.buttons.length === 0) {
            return;
        }

        // ✅ 檢查是否已展開（避免重複展開）
        if (richmenuNode.data.isExpanded) {
            toast.warning('此 Richmenu 已展開，請勿重複展開');
            return;
        }

        showLoader(`展開 ${richmenuNode.data.buttons.length} 個按鈕...`);
        try {
            // 標記此 Richmenu 已處理（避免循環）
            processedRichmenus.add(richmenuNode.data.richmenuId);


            // 改進的佈局算法：根據按鈕類型分組排列
            const baseX = richmenuNode.position.x + 400; // 按鈕節點在右側，增加間距
            const startY = richmenuNode.position.y - 100; // 從 Richmenu 上方開始
            const verticalGap = 120; // 減小垂直間距使佈局更緊湊

            // 按類型分組
            const buttonsByType = {
                uri: [],
                richmenuswitch: [],
                postback: [],
                message: [],
                other: []
            };

            richmenuNode.data.buttons.forEach((button, index) => {
                const action = button.action || button;
                const type = action.type || 'other';
                buttonsByType[type] = buttonsByType[type] || [];
                buttonsByType[type].push({ button, action, index });
            });

            let currentY = startY;


            for (let i = 0; i < richmenuNode.data.buttons.length; i++) {
                const button = richmenuNode.data.buttons[i];
                const action = button.action;


                if (!action || action.type === 'none') {
                    // 重要：即使跳過按鈕，也要增加 Y 位置，避免後續節點重疊
                    currentY += verticalGap;
                    continue;
                }

                const position = { x: baseX, y: currentY };
                let newNode = null;


                try {
                    // 添加微小延遲避免 Date.now() ID 衝突
                    await new Promise(resolve => setTimeout(resolve, 5));

                    switch (action.type) {
                        case 'uri':
                            newNode = this.addNode(NodeTypes.URL, position, true); // silent mode
                            if (newNode && newNode.data) {
                                newNode.data.url = action.uri || '';
                                newNode.data.label = `🔘 ${i + 1} - ${action.label || button.label || 'URL'}`;
                                // 重新渲染
                                const element = document.getElementById(newNode.id);
                                if (element) {
                                    element.remove();
                                    this.renderNode(newNode);
                                }
                            }
                            break;

                        case 'message':

                            // ✅ 檢查是否匹配 keyword
                            const matchedKeyword = await this.matchKeyword(action.text);

                            if (matchedKeyword) {
                                // 匹配到 keyword，創建 KEYWORD 節點
                                newNode = this.addNode(NodeTypes.KEYWORD, position, true);
                                if (newNode && newNode.data) {
                                    newNode.data.keyword = matchedKeyword.keyword;
                                    newNode.data.matchType = matchedKeyword.matchType || 'exact';
                                    newNode.data.label = `🔑 ${action.text}`;
                                    // 重新渲染
                                    const element = document.getElementById(newNode.id);
                                    if (element) {
                                        element.remove();
                                        this.renderNode(newNode);
                                    }

                                    // TODO: 連接到 keyword 的回覆訊息
                                    // 這需要從後端獲取 keyword 的回覆資料
                                }
                            } else {
                                // 沒有匹配，創建普通 Text 節點
                                newNode = this.addNode(NodeTypes.MESSAGE_TEXT, position, true);
                                if (newNode && newNode.data) {
                                    newNode.data.text = action.text || '';
                                    newNode.data.label = `🔘 ${i + 1} - ${action.label || button.label || 'Message'}`;
                                    // 重新渲染
                                    const element = document.getElementById(newNode.id);
                                    if (element) {
                                        element.remove();
                                        this.renderNode(newNode);
                                    }
                                }
                            }
                            break;

                        case 'postback':
                            newNode = this.addNode(NodeTypes.POSTBACK, position, true); // silent mode
                            if (newNode && newNode.data) {
                                newNode.data.data = action.data || '';
                                newNode.data.label = `🔘 ${i + 1} - ${action.label || button.label || 'Postback'}`;
                                newNode.data.displayText = action.displayText || '';
                                // 重新渲染
                                const element = document.getElementById(newNode.id);
                                if (element) {
                                    element.remove();
                                    this.renderNode(newNode);
                                }
                            }
                            break;

                        case 'richmenuswitch':
                            const targetAliasOrId = action.richMenuAliasId;

                            // 第一步：創建 Menu Switch 中間節點
                            const switchNode = this.addNode(NodeTypes.POSTBACK, position, true);
                            if (switchNode && switchNode.data) {
                                switchNode.data.data = `switch_to_${targetAliasOrId}`;
                                switchNode.data.label = `🔄 ${i + 1} - Menu Switch`;
                                switchNode.data.displayText = `切換到: ${action.label || button.label || targetAliasOrId}`;

                                // 設置特殊標記表示這是 menu switch
                                switchNode.data.isMenuSwitch = true;
                                switchNode.data.targetRichmenuId = targetAliasOrId;

                                // 重新渲染 switch 節點
                                const switchElement = document.getElementById(switchNode.id);
                                if (switchElement) {
                                    switchElement.remove();
                                    this.renderNode(switchNode);
                                }

                            }

                            // 第二步：解析目標 Richmenu 並創建/連接
                            const actualRichmenuId = await dataLoader.resolveRichmenuAlias(targetAliasOrId);

                            if (!actualRichmenuId) {
                                console.error(`[自動展開] 無法解析 Richmenu ID/Alias: ${targetAliasOrId}`);
                                newNode = switchNode; // 至少保留 switch 節點
                                break;
                            }


                            // 第三步：查找或創建目標 Richmenu
                            const targetRichmenuPosition = {
                                x: position.x + 300, // Menu Switch 右側
                                y: position.y
                            };

                            let targetNode = this.nodes.find(n =>
                                n.type === NodeTypes.RICHMENU &&
                                n.data.richmenuId === actualRichmenuId
                            );

                            if (targetNode) {
                            } else {
                                targetNode = this.addNode(NodeTypes.RICHMENU, targetRichmenuPosition, true);
                                if (targetNode) {
                                    try {
                                        const details = await dataLoader.loadRichmenuDetails(actualRichmenuId);

                                        if (details) {
                                            targetNode.data.richmenuId = details.richMenuId;
                                            targetNode.data.name = details.name;
                                            targetNode.data.buttons = details.buttons;
                                            targetNode.data.imageUrl = details.imageUrl;
                                            targetNode.data.size = details.size;
                                            targetNode.data.isAutoCreated = true;  // ✅ 標記為自動創建

                                            const element = document.getElementById(targetNode.id);
                                            if (element) {
                                                element.remove();
                                                this.renderNode(targetNode);
                                            }

                                            // 只有新創建的節點才需要繼續展開
                                            if (!processedRichmenus.has(actualRichmenuId)) {
                                                await this.expandRichmenuButtons(targetNode, processedRichmenus);
                                            }
                                        }
                                    } catch (error) {
                                        console.error('[自動展開] 載入 Richmenu 失敗:', error);
                                    }
                                }
                            }

                            // 第四步：創建 Menu Switch -> 目標 Richmenu 的連接
                            if (switchNode && targetNode) {
                                this.createEdge(switchNode.id, null, targetNode.id, null);
                            }

                            // 返回 switchNode（這樣主 Richmenu 會連到 switch node）
                            newNode = switchNode;
                            break;

                        default:
                            console.warn(`[自動展開] 未知的動作類型: ${action.type}`);
                    }

                    if (newNode) {
                        this.createEdge(richmenuNode.id, `button_${i}`, newNode.id, null);
                    } else {
                        console.error(`[自動展開] 節點創建失敗，按鈕 ${i + 1}`);
                    }

                    // 無論節點是否創建成功，都要增加 Y 位置（為下一個按鈕預留空間）
                    currentY += verticalGap;
                } catch (error) {
                    console.error(`[自動展開] 處理按鈕 ${i + 1} 時發生錯誤:`, error);
                    // 發生錯誤時也要增加 Y 位置
                    currentY += verticalGap;
                }
            }

            // 不需要 renderAll，因為每個節點和連接都已經在創建時渲染了

            // ✅ 標記為已展開
            richmenuNode.data.isExpanded = true;

            this.saveToLocalStorage();
            toast.success(`✅ 已展開 ${richmenuNode.data.name} 的所有按鈕`);
        } catch (error) {
            console.error('[自動展開] 發生錯誤:', error);
            toast.error('展開失敗: ' + error.message);
        } finally {
            hideLoader();
        }
    }

    /**
     * 自動展開 Flex Message 按鈕，創建對應的節點
     */
    async expandFlexButtons(flexNode) {
        if (!flexNode.data.buttons || flexNode.data.buttons.length === 0) {
            toast.warning('此 Flex Message 沒有按鈕');
            return;
        }

        // ✅ 檢查是否已展開
        if (flexNode.data.isExpanded) {
            toast.warning('此 Flex Message 已展開，請勿重複展開');
            return;
        }

        showLoader(`展開 ${flexNode.data.buttons.length} 個按鈕...`);
        try {
            const baseX = flexNode.position.x + 400;
            const startY = flexNode.position.y - 100;
            const verticalGap = 120;
            let currentY = startY;

            for (let i = 0; i < flexNode.data.buttons.length; i++) {
                const button = flexNode.data.buttons[i];
                const action = button.action;

                if (!action || action.type === 'none') {
                    currentY += verticalGap;
                    continue;
                }

                const position = { x: baseX, y: currentY };
                let newNode = null;

                await new Promise(resolve => setTimeout(resolve, 5));

                switch (action.type) {
                    case 'uri':
                        newNode = this.addNode(NodeTypes.URL, position, true);
                        if (newNode) {
                            newNode.data.url = action.uri || '';
                            newNode.data.label = `🔘 ${i + 1} - ${action.label || button.label || 'URL'}`;
                            const el = document.getElementById(newNode.id);
                            if (el) { el.remove(); this.renderNode(newNode); }
                        }
                        break;
                    case 'message':
                        newNode = this.addNode(NodeTypes.MESSAGE_TEXT, position, true);
                        if (newNode) {
                            newNode.data.text = action.text || '';
                            newNode.data.label = `🔘 ${i + 1} - ${action.label || button.label || 'Message'}`;
                            const el = document.getElementById(newNode.id);
                            if (el) { el.remove(); this.renderNode(newNode); }
                        }
                        break;
                    case 'postback':
                        newNode = this.addNode(NodeTypes.POSTBACK, position, true);
                        if (newNode) {
                            newNode.data.data = action.data || '';
                            newNode.data.label = `🔘 ${i + 1} - ${action.label || button.label || 'Postback'}`;
                            const el = document.getElementById(newNode.id);
                            if (el) { el.remove(); this.renderNode(newNode); }
                        }
                        break;
                }

                if (newNode) {
                    this.createEdge(flexNode.id, `button_${i}`, newNode.id, 'input');
                }

                currentY += verticalGap;
            }


            flexNode.data.isExpanded = true;
            this.saveToLocalStorage();
            toast.success(`✅ 已展開 ${flexNode.data.title || 'Flex Message'} 的所有按鈕`);
        } catch (error) {
            console.error('[展開 Flex] 錯誤:', error);
            toast.error('展開失敗');
        } finally {
            hideLoader();
        }
    }

    /**
     * 自動展開 Imagemap 按鈕，創建對應的節點
     */
    async expandImagemapButtons(imagemapNode) {
        if (!imagemapNode.data.actions || imagemapNode.data.actions.length === 0) {
            toast.warning('此 Imagemap 沒有可點擊區域');
            return;
        }

        // 檢查是否已展開
        if (imagemapNode.data.isExpanded) {
            toast.warning('此 Imagemap 已展開，請勿重複展開');
            return;
        }

        showLoader(`展開 ${imagemapNode.data.actions.length} 個可點擊區域...`);
        try {

            // 佈局設定
            const baseX = imagemapNode.position.x + 400; // 按鈕節點在右側
            const startY = imagemapNode.position.y - 100;
            const verticalGap = 120;
            let currentY = startY;

            for (let i = 0; i < imagemapNode.data.actions.length; i++) {
                const action = imagemapNode.data.actions[i];


                if (!action || action.type === 'none') {
                    currentY += verticalGap;
                    continue;
                }

                const position = { x: baseX, y: currentY };
                let newNode = null;

                // 添加微小延遲避免 ID 衝突
                await new Promise(resolve => setTimeout(resolve, 5));

                switch (action.type) {
                    case 'uri':
                        newNode = this.addNode(NodeTypes.URL, position, true);
                        if (newNode && newNode.data) {
                            newNode.data.url = action.linkUri || '';
                            newNode.data.label = `🗺️ ${i + 1} - URL`;
                            const el = document.getElementById(newNode.id);
                            if (el) { el.remove(); this.renderNode(newNode); }
                        }
                        break;

                    case 'message':

                        // 檢查是否匹配 keyword
                        const matchedKeyword = await this.matchKeyword(action.text);

                        if (matchedKeyword) {
                            newNode = this.addNode(NodeTypes.KEYWORD, position, true);
                            if (newNode && newNode.data) {
                                newNode.data.keyword = matchedKeyword.keyword;
                                newNode.data.matchType = matchedKeyword.matchType || 'exact';
                                newNode.data.label = `🔑 ${action.text}`;
                                const el = document.getElementById(newNode.id);
                                if (el) { el.remove(); this.renderNode(newNode); }
                            }
                        } else {
                            newNode = this.addNode(NodeTypes.MESSAGE_TEXT, position, true);
                            if (newNode && newNode.data) {
                                newNode.data.text = action.text || '';
                                newNode.data.label = `🗺️ ${i + 1} - ${action.text?.substring(0, 15) || 'Text'}`;
                                const el = document.getElementById(newNode.id);
                                if (el) { el.remove(); this.renderNode(newNode); }
                            }
                        }
                        break;

                    case 'postback':
                        newNode = this.addNode(NodeTypes.POSTBACK, position, true);
                        if (newNode) {
                            newNode.data.data = action.data || '';
                            newNode.data.label = `🗺️ ${i + 1} - Postback`;
                            const el = document.getElementById(newNode.id);
                            if (el) { el.remove(); this.renderNode(newNode); }
                        }
                        break;

                    default:
                }

                // 創建連線
                if (newNode) {
                    this.createEdge(imagemapNode.id, `action_${i}`, newNode.id, 'input');
                }

                currentY += verticalGap;
            }

            imagemapNode.data.isExpanded = true;
            this.saveToLocalStorage();
            toast.success(`✅ 已展開 ${imagemapNode.data.title || 'Imagemap'} 的所有區域`);
        } catch (error) {
            console.error('[展開 Imagemap] 錯誤:', error);
            toast.error('展開失敗: ' + error.message);
        } finally {
            hideLoader();
        }
    }

    /**
     * 選擇 Flex Message
     */
    async selectFlex(nodeId) {
        const selectElement = document.getElementById('resource-select-flex');
        const flexId = selectElement.value;

        if (!flexId) {
            toast.warning('請先選擇一個 Flex Message');
            return;
        }

        showLoader('載入 Flex Message 資料中...');
        try {
            const details = await dataLoader.loadFlexMessageDetails(flexId);
            if (details) {
                const node = this.nodes.find(n => n.id === nodeId);
                if (node) {
                    node.data.flexId = details.flexId;
                    node.data.title = details.title || '未命名';
                    node.data.altText = details.altText || details.title;
                    node.data.contents = details.contents; // 保存完整的 Flex JSON

                    // ✅ 提取按鈕資料
                    node.data.buttons = this.extractFlexButtons(details.contents);

                    // 重新渲染節點以顯示預覽
                    const nodeElement = document.getElementById(nodeId);
                    if (nodeElement) {
                        nodeElement.remove();
                        this.renderNode(node);
                    }

                    this.showNodeProperties(nodeId);
                    this.saveToLocalStorage();
                    toast.success('✅ Flex Message 已載入');
                }
            }
        } catch (error) {
            console.error('[載入 Flex] 錯誤:', error);
            toast.error('載入失敗');
        } finally {
            hideLoader();
        }
    }

    /**
     * 選擇 Keyword
     */
    async selectKeyword(nodeId) {
        const selectElement = document.getElementById('resource-select-keyword');
        const keyword = selectElement.value;

        if (!keyword) {
            toast.warning('請先選擇一個關鍵字');
            return;
        }

        showLoader('載入 Keyword 資料中...');
        try {
            // 從 keyword list 中找到這個 keyword
            const keywords = await this.loadKeywordList();
            const keywordData = keywords.find(kw => kw.keyword === keyword);

            if (keywordData) {
                const node = this.nodes.find(n => n.id === nodeId);
                if (node) {
                    node.data.keyword = keywordData.keyword;
                    node.data.matchType = keywordData.matchType || 'exact';
                    node.data.label = `🔑 ${keywordData.keyword}`;

                    // ✅ 載入並創建回覆節點
                    if (keywordData.replies && keywordData.replies.length > 0) {

                        const baseX = node.position.x + 400;
                        const startY = node.position.y - 50;
                        const verticalGap = 120;
                        let currentY = startY;

                        for (let i = 0; i < keywordData.replies.length; i++) {
                            const reply = keywordData.replies[i];
                            const position = { x: baseX, y: currentY };
                            let replyNode = null;


                            // 根據回覆類型創建對應節點
                            if (reply.type === 'imagemap') {

                                replyNode = this.addNode(NodeTypes.MESSAGE_IMAGEMAP, position, true);
                                if (replyNode) {
                                    try {
                                        // ✅ 關鍵修正：reply 本身就包含完整資料！
                                        // 不需要再從 dataLoader 載入，直接使用 reply 的資料
                                        if (reply.baseUrl && reply.actions) {

                                            // 直接設置完整資料
                                            replyNode.data.imagemapId = reply.baseUrl;
                                            replyNode.data.title = reply.altText || 'Imagemap';
                                            replyNode.data.altText = reply.altText;
                                            replyNode.data.baseUrl = reply.baseUrl;
                                            replyNode.data.baseSize = reply.baseSize;
                                            replyNode.data.actions = reply.actions;
                                            replyNode.data.imageUrl = reply.baseUrl;
                                            replyNode.data.label = `🗺️ ${reply.altText || 'Imagemap'}`;

                                            // 重新渲染以顯示圖片
                                            const el = document.getElementById(replyNode.id);
                                            if (el) {
                                                el.remove();
                                                this.renderNode(replyNode);
                                            }

                                            // ⚠️ 不要自動展開，讓用戶手動展開避免位置混亂
                                        } else {
                                            console.warn('[載入 Keyword] ❌ reply 缺少 baseUrl 或 actions');
                                            replyNode.data.label = `🗺️ Imagemap (資料不完整)`;
                                        }

                                    } catch (error) {
                                        console.error('[載入 Keyword] 載入 Imagemap 失敗:', error);
                                        replyNode.data.label = `🗺️ Imagemap (載入失敗)`;
                                    }
                                }
                            } else if (reply.type === 'flex') {

                                replyNode = this.addNode(NodeTypes.MESSAGE_FLEX, position, true);
                                if (replyNode) {
                                    try {
                                        // ✅ 載入完整的 Flex Message 資料
                                        if (reply.id) {
                                            const flexMessages = await dataLoader.loadFlexMessages();
                                            const flexMessage = flexMessages.find(fm => fm.id === reply.id);

                                            if (flexMessage && flexMessage.contents) {

                                                // 設置完整資料
                                                replyNode.data.flexId = flexMessage.id;
                                                replyNode.data.title = flexMessage.title || reply.title || 'Flex Message';
                                                replyNode.data.contents = flexMessage.contents;
                                                replyNode.data.label = `📱 ${flexMessage.title || 'Flex Message'}`;

                                                // 重新渲染以顯示 Flex 內容
                                                const el = document.getElementById(replyNode.id);
                                                if (el) {
                                                    el.remove();
                                                    this.renderNode(replyNode);
                                                }

                                                // ⚠️ 不要自動展開，讓用戶手動展開避免位置混亂
                                            } else {
                                                console.warn('[載入 Keyword] ❌ 找不到 Flex Message:', reply.id);
                                                replyNode.data.flexId = reply.id;
                                                replyNode.data.title = reply.title || 'Flex Message';
                                                replyNode.data.label = `📱 ${reply.title || 'Flex Message (未載入)'}`;
                                            }
                                        } else {
                                            console.warn('[載入 Keyword] ❌ reply 缺少 id');
                                            replyNode.data.title = reply.title || 'Flex Message';
                                            replyNode.data.label = `📱 ${reply.title || 'Flex Message (無ID)'}`;
                                        }

                                    } catch (error) {
                                        console.error('[載入 Keyword] 載入 Flex 失敗:', error);
                                        replyNode.data.flexId = reply.id;
                                        replyNode.data.title = reply.title || 'Flex Message';
                                        replyNode.data.label = `📱 ${reply.title || 'Flex Message (載入失敗)'}`;
                                    }
                                }
                            } else if (reply.type === 'message' || reply.type === 'text') {

                                // ✅ 檢查是否匹配 keyword
                                const matchedKeyword = await this.matchKeyword(reply.text);

                                if (matchedKeyword) {
                                    // 匹配到 keyword，創建 KEYWORD 節點
                                    replyNode = this.addNode(NodeTypes.KEYWORD, position, true);
                                    if (replyNode) {
                                        replyNode.data.keyword = matchedKeyword.keyword;
                                        replyNode.data.matchType = matchedKeyword.matchType || 'exact';
                                        replyNode.data.label = `🔑 ${reply.text}`;

                                        const el = document.getElementById(replyNode.id);
                                        if (el) { el.remove(); this.renderNode(replyNode); }
                                    }
                                } else {
                                    // 沒有匹配，創建普通 Text 節點
                                    replyNode = this.addNode(NodeTypes.MESSAGE_TEXT, position, true);
                                    if (replyNode) {
                                        replyNode.data.text = reply.text || '';
                                        replyNode.data.label = `💬 ${reply.text?.substring(0, 20) || 'Text'}`;

                                        const el = document.getElementById(replyNode.id);
                                        if (el) { el.remove(); this.renderNode(replyNode); }
                                    }
                                }
                            }

                            // 創建連接
                            if (replyNode) {
                                this.createEdge(nodeId, 'output', replyNode.id, 'input');
                            }

                            currentY += verticalGap;
                        }
                    }

                    // 重新渲染 keyword 節點
                    const nodeElement = document.getElementById(nodeId);
                    if (nodeElement) {
                        nodeElement.remove();
                        this.renderNode(node);
                    }

                    this.showNodeProperties(nodeId);
                    this.saveToLocalStorage();
                    toast.success(`✅ Keyword 已載入，創建 ${keywordData.replies?.length || 0} 個回覆節點`);
                }
            } else {
                toast.error('找不到指定的 Keyword');
            }
        } catch (error) {
            console.error('[載入 Keyword] 錯誤:', error);
            toast.error('載入失敗');
        } finally {
            hideLoader();
        }
    }

    /**
     * 從 Flex JSON 提取按鈕資料
     */
    extractFlexButtons(contents) {
        if (!contents) return [];

        const buttons = [];

        // 遞迴搜尋 Flex JSON 中的所有 action
        const findActions = (obj, path = '') => {
            if (!obj || typeof obj !== 'object') return;

            if (obj.type === 'button' && obj.action) {
                buttons.push({
                    label: obj.action.label || obj.label || '按鈕',  // ✅ 優先嘗試 action.label，再試 label
                    action: obj.action
                });
            }

            // 遞迴搜尋子元素
            for (const key in obj) {
                if (Array.isArray(obj[key])) {
                    obj[key].forEach((item, idx) => findActions(item, `${path}.${key}[${idx}]`));
                } else if (typeof obj[key] === 'object') {
                    findActions(obj[key], `${path}.${key}`);
                }
            }
        };

        findActions(contents);


        return buttons;
    }

    /**
     * 選擇 Imagemap
     */
    async selectImagemap(nodeId) {
        // 嘗試多種方式找到選擇器
        let selectElement = document.getElementById('resource-select-imagemap');

        // 如果找不到，嘗試在屬性面板中查找
        if (!selectElement) {
            const propertiesPanel = document.getElementById('node-properties');
            if (propertiesPanel) {
                selectElement = propertiesPanel.querySelector('select.form-select');
            }
        }


        if (!selectElement) {
            console.error('[selectImagemap] 找不到選擇器元素');
            toast.error('找不到選擇器');
            return;
        }

        const imagemapId = selectElement.value;

        if (!imagemapId) {
            toast.warning('請先選擇一個 Imagemap');
            return;
        }

        const node = this.nodes.find(n => n.id === nodeId);
        if (!node) {
            toast.error('找不到節點');
            return;
        }

        try {
            showLoader('載入 Imagemap 資料...');

            // 載入所有 Imagemap
            const imagemaps = await dataLoader.loadImagemaps();

            // Debug: 顯示所有 Imagemap 的 baseUrl
            if (imagemaps.length > 0) {
            }

            const imagemap = imagemaps.find(i => i.baseUrl === imagemapId);

            if (!imagemap) {
                console.error('[selectImagemap] 找不到 Imagemap！');
                console.error('[selectImagemap] 尋找的 baseUrl:', imagemapId);
                console.error('[selectImagemap] 可用的 baseUrls:', imagemaps.map(i => i.baseUrl));
                throw new Error('找不到 Imagemap');
            }


            // 更新節點資料（使用 baseUrl 作為 ID）
            node.data.imagemapId = imagemap.baseUrl;  // 使用 baseUrl 作為 ID
            node.data.title = imagemap.altText || imagemap.baseUrl;
            node.data.altText = imagemap.altText;
            node.data.baseUrl = imagemap.baseUrl;    // Imagemap 基礎 URL
            node.data.baseSize = imagemap.baseSize;  // 圖片尺寸
            node.data.actions = imagemap.actions;    // 保存 actions
            node.data.imageUrl = imagemap.baseUrl;   // 使用 baseUrl 作為圖片 URL


            // 重新渲染節點以顯示圖片
            const oldElement = document.getElementById(node.id);
            if (oldElement) {
                oldElement.remove();
            }
            this.renderNode(node);

            // 更新連線
            this.updateConnectedEdges(node.id);

            // 更新屬性面板
            this.showNodeProperties(nodeId);

            // 儲存
            this.saveToLocalStorage();

            toast.success('✅ Imagemap 已載入');
        } catch (err) {
            console.error('❌ [selectImagemap] 載入 Imagemap 失敗:', err);
            console.error('[selectImagemap] 錯誤堆疊:', err.stack);
            toast.error('載入 Imagemap 失敗: ' + err.message);
        } finally {
            hideLoader();
        }
    }

    /**
     * 重新載入所有 Richmenu 節點的資料（圖片等）
     */
    async refreshAllRichmenuData() {
        const richmenuNodes = this.nodes.filter(n => n.type === NodeTypes.RICHMENU && n.data.richmenuId);

        if (richmenuNodes.length === 0) {
            return;
        }


        for (const node of richmenuNodes) {
            try {
                const details = await dataLoader.loadRichmenuDetails(node.data.richmenuId);
                if (details) {
                    // 更新節點資料
                    node.data.name = details.name;
                    node.data.imageUrl = details.imageUrl;
                    node.data.buttons = details.buttons || [];

                    // 重新渲染節點
                    const nodeElement = document.getElementById(node.id);
                    if (nodeElement) {
                        nodeElement.remove();
                        this.renderNode(node);
                    }

                }
            } catch (error) {
                console.error(`[刷新 Richmenu] ❌ ${node.id} 刷新失敗:`, error);
            }
        }

    }
}
