// js/flow_designer_data_loader.js
// 流程設計器資料載入器 - 整合現有資料

import {
    fetchMessageListByType,
    fetchKeywordReplies
} from '../helper/message.helper.js';
import { getUserId, apiBase } from '../helper/state.js';
import { toast } from '../helper/toast.js';

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
            const res = await fetch(`${apiBase}/richmenu/list`, {
                headers: { 'X-User-Id': getUserId() }
            });

            if (!res.ok) throw new Error('無法載入 Richmenu 列表');

            const data = await res.json();
            this.cache.richmenus = data.richmenus || [];

            console.log('✅ 載入 Richmenu:', this.cache.richmenus.length, '個');
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
            console.log(`[resolveRichmenuAlias] 開始解析: ${aliasId}`);

            // 如果已經是 richmenu- 開頭的 ID，直接返回
            if (aliasId.startsWith('richmenu-')) {
                console.log(`[resolveRichmenuAlias] 已經是 Richmenu ID，直接返回`);
                return aliasId;
            }

            console.log(`[resolveRichmenuAlias] 載入 alias 列表...`);

            // 載入所有 alias
            const res = await fetch(`${apiBase}/alias/getAliaslist`, {
                headers: { 'X-User-Id': getUserId() }
            });

            console.log(`[resolveRichmenuAlias] API 回應狀態: ${res.status}`);

            if (!res.ok) {
                console.error(`[resolveRichmenuAlias] 無法載入 alias 列表: ${res.status}`);
                const errorText = await res.text();
                console.error(`[resolveRichmenuAlias] 錯誤詳情:`, errorText);
                return null;
            }

            const data = await res.json();
            console.log(`[resolveRichmenuAlias] API 回應數據:`, data);

            const aliases = data.aliases || [];
            console.log(`[resolveRichmenuAlias] 找到 ${aliases.length} 個 alias`);

            // 找到匹配的 alias
            const alias = aliases.find(a => a.richMenuAliasId === aliasId);

            if (alias) {
                console.log(`✅ [resolveRichmenuAlias] 解析成功: ${aliasId} -> ${alias.richMenuId}`);
                return alias.richMenuId;
            } else {
                console.warn(`❌ [resolveRichmenuAlias] 找不到 alias: ${aliasId}`);
                console.warn(`[resolveRichmenuAlias] 可用的 alias:`, aliases.map(a => a.richMenuAliasId));
                return null;
            }
        } catch (err) {
            console.error('❌ [resolveRichmenuAlias] 發生錯誤:', err);
            console.error('[resolveRichmenuAlias] 錯誤堆疊:', err.stack);
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
            const metadataRes = await fetch(`${apiBase}/richmenu/metadata/${richMenuId}`, {
                headers: { 'X-User-Id': getUserId() }
            });

            if (!metadataRes.ok) throw new Error('無法載入 Richmenu metadata');

            const metadata = await metadataRes.json();

            // 載入圖片
            const imageRes = await fetch(`${apiBase}/richmenu/image/${richMenuId}`, {
                headers: { 'X-User-Id': getUserId() }
            });

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

            console.log('✅ 載入 Richmenu 詳細資料:', details.name, details.buttons.length, '個按鈕');
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

            console.log('✅ 載入 Flex Message:', this.cache.flexMessages.length, '個');
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
        console.log('🔍 從 Flex 中找到', buttons.length, '個按鈕');
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

            console.log('✅ 載入 Imagemap:', this.cache.imagemaps.length, '個');
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

            console.log('✅ 載入關鍵字:', this.cache.keywords.length, '個');
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
            const res = await fetch(`${apiBase}/token/list`, {
                headers: { 'X-User-Id': getUserId() }
            });

            if (!res.ok) throw new Error('無法載入專案列表');

            const projects = await res.json();
            this.cache.projects = Object.entries(projects).map(([name, botId]) => ({
                name: name,
                botId: botId
            }));

            console.log('✅ 載入專案:', this.cache.projects.length, '個');
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
        console.log('🧹 快取已清除');
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
        console.log('📥 開始載入所有資料...');

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

        console.log('✅ 資料載入完成:', summary);
        return summary;
    }

    /**
     * 產生資源選擇器 HTML
     */
    renderResourceSelector(type, selectedId = null) {
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
                idField: 'id',
                nameField: 'title'
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

        let html = `
            <label class="form-label">
                <i class="${config.icon}"></i> ${config.title}
            </label>
            <select class="form-select mb-2" id="resource-select-${type}">
                <option value="">請選擇...</option>
        `;

        data.forEach(item => {
            const id = item[config.idField];
            const name = item[config.nameField] || id;
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
