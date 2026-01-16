// js/flow_designer_data_loader.js
// 流程設計器資料載入器 - 整合現有資料

import {
    fetchMessageListByType,
    fetchKeywordReplies
} from '../helper/message.helper.js';
import { getUserId } from '../helper/state.js';
import { toast } from '../helper/toast.js';
import { ApiClient as api } from '../helper/api.client.js';

/**
 * 流程設計器資料載入器
 * 負責從後端載入各種資源（Richmenu, Flex, Imagemap 等）
 */
export class FlowDataLoader {
    constructor() {
        this.cache = {
            richmenus: null,
            flexMessages: null,
            imagemaps: null,
            keywords: null,
            projects: null
        };

        // 自動載入
        this.loadAllData();
    }

    /**
     * 載入所有 Richmenu
     */
    async loadRichmenus() {
        if (this.cache.richmenus) return this.cache.richmenus;

        try {
            const data = await api.get('/richmenu/list');
            this.cache.richmenus = data.richmenus || [];
            return this.cache.richmenus;
        } catch (err) {
            console.error('❌ 載入 Richmenu 失敗:', err);
            toast.error('載入 Richmenu 失敗');
            return [];
        }
    }

    /**
     * 解析 Richmenu alias 為實際的 Richmenu ID
     */
    async resolveRichmenuAlias(aliasId) {
        try {
            // 如果已經是 richmenu- 開頭的 ID，直接返回
            if (aliasId.startsWith('richmenu-')) {
                return aliasId;
            }

            // 載入所有 alias
            const data = await api.get('/alias/getAliaslist');
            const aliases = data.aliases || [];

            // 找到匹配的 alias
            const alias = aliases.find(a => a.richMenuAliasId === aliasId);

            if (alias) {
                return alias.richMenuId;
            } else {
                console.warn(`❌ [resolveRichmenuAlias] 找不到 alias: ${aliasId}`);
                console.warn(`[resolveRichmenuAlias] 可用的 alias:`, aliases.map(a => a.richMenuAliasId));
                return null;
            }
        } catch (err) {
            console.error('❌ [resolveRichmenuAlias] 發生錯誤:', err);
            return null;
        }
    }

    /**
     * 載入單一 Richmenu 的詳細資料（包含按鈕資訊）
     * 支援 alias ID 自動解析
     */
    async loadRichmenuDetails(richMenuIdOrAlias) {
        try {
            // 先解析 alias（如果需要）
            const richMenuId = await this.resolveRichmenuAlias(richMenuIdOrAlias);

            if (!richMenuId) {
                console.error(`無法解析 Richmenu ID/Alias: ${richMenuIdOrAlias}`);
                return null;
            }

            // 載入 metadata
            const metadata = await api.get(`/richmenu/metadata/${richMenuId}`);

            // 載入圖片 (使用原始 fetch 因為需要 blob)
            const imageRes = await api.get(`/richmenu/image/${richMenuId}`, { rawResponse: true });

            let imageUrl = null;
            if (imageRes.ok) {
                const blob = await imageRes.blob();
                imageUrl = URL.createObjectURL(blob);
            }

            const details = {
                richMenuId: richMenuId,
                name: metadata.name || richMenuId,
                size: metadata.size || { width: 2500, height: 1686 },
                chatBarText: metadata.chatBarText || '選單',
                areas: metadata.areas || [],
                imageUrl: imageUrl,
                // 將 areas 轉換成按鈕列表
                buttons: (metadata.areas || []).map((area, index) => ({
                    id: `btn_${index}`,
                    label: this.getActionLabel(area.action),
                    bounds: area.bounds,
                    action: area.action
                }))
            };

            return details;
        } catch (err) {
            console.error('❌ 載入 Richmenu 詳細資料失敗:', err);
            toast.error('載入 Richmenu 詳細資料失敗');
            return null;
        }
    }

    /**
     * 取得 action 的顯示標籤
     */
    getActionLabel(action) {
        if (!action) return '未設定';

        switch (action.type) {
            case 'message':
                return `💬 ${action.text?.substring(0, 15) || '訊息'}`;
            case 'uri':
                return `🔗 ${action.label || 'URL'}`;
            case 'postback':
                return `📦 ${action.label || 'Postback'}`;
            case 'richmenuswitch':
                return `🔄 ${action.label || '切換選單'}`;
            default:
                return action.type;
        }
    }

    /**
     * 載入所有 Flex Message
     */
    async loadFlexMessages() {
        if (this.cache.flexMessages) return this.cache.flexMessages;

        try {
            const data = await fetchMessageListByType('flex', getUserId());
            this.cache.flexMessages = data || [];

            return this.cache.flexMessages;
        } catch (err) {
            console.error('❌ 載入 Flex Message 失敗:', err);
            toast.error('載入 Flex Message 失敗');
            return [];
        }
    }

    /**
     * 載入單一 Flex Message 的詳細資料
     */
    async loadFlexMessageDetails(flexId) {
        try {
            const allFlex = await this.loadFlexMessages();
            const flex = allFlex.find(f => f.id === flexId);

            if (!flex) {
                throw new Error(`找不到 Flex Message: ${flexId}`);
            }

            // 解析 Flex 內容，提取按鈕
            const buttons = this.extractFlexButtons(flex.contents);

            return {
                flexId: flex.id,
                title: flex.title || flex.altText || 'Flex Message',
                altText: flex.altText,
                contents: flex.contents,
                buttons: buttons
            };
        } catch (err) {
            console.error('❌ 載入 Flex Message 詳細資料失敗:', err);
            return null;
        }
    }

    /**
     * 從 Flex contents 中提取按鈕資訊
     */
    extractFlexButtons(contents) {
        const buttons = [];

        const findButtons = (obj, path = '') => {
            if (!obj || typeof obj !== 'object') return;

            // 找到按鈕
            if (obj.type === 'button' && obj.action) {
                buttons.push({
                    id: `action_${buttons.length}`,
                    label: obj.action.label || obj.action.text || '按鈕',
                    action: obj.action
                });
            }

            // 遞迴搜尋
            for (const key in obj) {
                if (typeof obj[key] === 'object') {
                    findButtons(obj[key], `${path}.${key}`);
                }
            }
        };

        findButtons(contents);
        return buttons;
    }

    /**
     * 載入所有 Imagemap
     */
    async loadImagemaps() {
        if (this.cache.imagemaps) return this.cache.imagemaps;

        try {
            const data = await fetchMessageListByType('imagemap', getUserId());

            this.cache.imagemaps = data || [];


            // Debug: 顯示第一個 Imagemap 的完整資料結構
            if (this.cache.imagemaps.length > 0) {
            }

            return this.cache.imagemaps;
        } catch (err) {
            console.error('❌ 載入 Imagemap 失敗:', err);
            toast.error('載入 Imagemap 失敗');
            return [];
        }
    }

    /**
     * 載入關鍵字列表
     */
    async loadKeywords() {
        if (this.cache.keywords) return this.cache.keywords;

        try {
            const data = await fetchKeywordReplies(getUserId());
            this.cache.keywords = data || [];

            return this.cache.keywords;
        } catch (err) {
            console.error('❌ 載入關鍵字失敗:', err);
            toast.error('載入關鍵字失敗');
            return [];
        }
    }

    /**
     * 載入專案/Bot 列表
     */
    async loadProjects() {
        if (this.cache.projects) return this.cache.projects;

        try {
            const projects = await api.get('/token/list');
            this.cache.projects = Object.entries(projects).map(([name, botId]) => ({
                name: name,
                botId: botId
            }));

            return this.cache.projects;
        } catch (err) {
            console.error('❌ 載入專案失敗:', err);
            toast.error('載入專案失敗');
            return [];
        }
    }

    /**
     * 清除快取
     */
    clearCache() {
        this.cache = {
            richmenus: null,
            flexMessages: null,
            imagemaps: null,
            keywords: null,
            projects: null
        };
    }

    /**
     * 重新載入特定類型的資料
     */
    async reloadData(type) {
        switch (type) {
            case 'richmenu':
                this.cache.richmenus = null;
                return await this.loadRichmenus();
            case 'flex':
                this.cache.flexMessages = null;
                return await this.loadFlexMessages();
            case 'imagemap':
                this.cache.imagemaps = null;
                return await this.loadImagemaps();
            case 'keyword':
                this.cache.keywords = null;
                return await this.loadKeywords();
            case 'project':
                this.cache.projects = null;
                return await this.loadProjects();
            default:
                console.warn('未知的資料類型:', type);
                return [];
        }
    }

    /**
     * 載入所有必要資料（初始化用）
     */
    async loadAllData() {

        const results = await Promise.allSettled([
            this.loadRichmenus(),
            this.loadFlexMessages(),
            this.loadImagemaps(),
            this.loadKeywords(),
            this.loadProjects()
        ]);

        const summary = {
            richmenus: results[0].status === 'fulfilled' ? results[0].value.length : 0,
            flexMessages: results[1].status === 'fulfilled' ? results[1].value.length : 0,
            imagemaps: results[2].status === 'fulfilled' ? results[2].value.length : 0,
            keywords: results[3].status === 'fulfilled' ? results[3].value.length : 0,
            projects: results[4].status === 'fulfilled' ? results[4].value.length : 0
        };

        return summary;
    }

    /**
     * 產生資源選擇器 HTML
     */
    renderResourceSelector(type, selectedId = null, disabled = false) {
        const options = {
            richmenu: {
                title: '選擇 Richmenu',
                icon: 'bi-menu-button',
                dataGetter: () => this.cache.richmenus || [],
                idField: 'richMenuId',
                nameField: 'name'
            },
            flex: {
                title: '選擇 Flex Message',
                icon: 'bi-phone',
                dataGetter: () => this.cache.flexMessages || [],
                idField: 'id',
                nameField: 'title'
            },
            imagemap: {
                title: '選擇 Imagemap',
                icon: 'bi-image',
                dataGetter: () => this.cache.imagemaps || [],
                idField: 'baseUrl',  // Imagemap 沒有 id 欄位，使用 baseUrl 作為唯一識別
                nameField: 'altText'  // Imagemap 使用 altText 作為名稱
            },
            keyword: {
                title: '選擇關鍵字',
                icon: 'bi-key',
                dataGetter: () => this.cache.keywords || [],
                idField: 'keyword',
                nameField: 'keyword'
            }
        };

        const config = options[type];
        if (!config) return '<p class="text-danger">未知的資源類型</p>';

        const data = config.dataGetter();

        if (data.length === 0) {
            return `
                <div class="alert alert-warning">
                    <i class="${config.icon}"></i>
                    尚無可用的${config.title}
                    <button class="btn btn-sm btn-primary mt-2" onclick="dataLoader.reloadData('${type}')">
                        <i class="bi bi-arrow-clockwise"></i> 重新載入
                    </button>
                </div>
            `;
        }

        const disabledAttr = disabled ? 'disabled' : '';
        const disabledClass = disabled ? 'bg-light' : '';

        let html = `
            <label class="form-label">
                <i class="${config.icon}"></i> ${config.title}
                ${disabled ? '<span class="badge bg-secondary ms-2">已鎖定</span>' : ''}
            </label>
            <select class="form-select mb-2 ${disabledClass}" id="resource-select-${type}" ${disabledAttr}>
                <option value="">請選擇...</option>
        `;

        data.forEach(item => {
            const id = item[config.idField];
            // 優先使用指定欄位，如果為空則嘗試其他欄位，最後使用 id
            const name = item[config.nameField] || item.title || item.name || id;
            const selected = id === selectedId ? 'selected' : '';
            html += `<option value="${id}" ${selected}>${name}</option>`;
        });

        html += `
            </select>
            <button class="btn btn-sm btn-outline-secondary w-100" onclick="dataLoader.reloadData('${type}')">
                <i class="bi bi-arrow-clockwise"></i> 重新載入
            </button>
        `;

        return html;
    }
}

// 建立全域實例
export const dataLoader = new FlowDataLoader();
window.dataLoader = dataLoader; // 供 HTML 使用
