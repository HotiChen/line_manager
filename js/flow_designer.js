// js/flow_designer.js
// LINE Bot 視覺化流程設計器

import { liffId as configLiffId } from '../env/config.js';
import { getUserId, setUserId } from '../helper/state.js';
import { toast } from '../helper/toast.js';
import { dataLoader } from './flow_designer_data_loader.js';
import { ApiClient as api } from '../helper/api.client.js';
import { NodeTypes, NodeTypeConfig } from './flow/node_types.js';
import { FlowStore } from './flow/flow_store.js';
import { History } from './flow/history.js';
import { toPersisted, hydrateNodes } from './flow/serialize.js';
import { CanvasMethods } from './flow/designer/canvas.js';
import { EventsMethods } from './flow/designer/events.js';
import { NodeViewMethods } from './flow/designer/node_view.js';
import { EdgeViewMethods } from './flow/designer/edge_view.js';
import { ToolsMethods } from './flow/designer/tools.js';
import { PreviewsMethods } from './flow/designer/previews.js';
import { PropertiesMethods } from './flow/designer/properties.js';
import { ResourcesMethods } from './flow/designer/resources.js';
import { PersistMethods } from './flow/designer/persist.js';
import { DebugMethods } from './flow/designer/debug.js';
import { bindActions } from './flow/designer/actions.js';

// 相容：其他檔案仍可從 flow_designer.js 取用
export { NodeTypes, NodeTypeConfig };

/** 依職責拆開的方法群（每個檔案一個 class），組裝到 FlowDesigner.prototype */
export const DESIGNER_MIXINS = [
    CanvasMethods, EventsMethods, NodeViewMethods, EdgeViewMethods, ToolsMethods,
    PreviewsMethods, PropertiesMethods, ResourcesMethods, PersistMethods, DebugMethods,
];

/**
 * 流程設計器類別
 */
export class FlowDesigner {
    constructor(containerId) {
        this.isDirty = false;
        this._autoSaveTimer = null;
        window.addEventListener('beforeunload', (e) => {
            if (this.isDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        this.container = document.getElementById(containerId);
        // 資料一律在 store；this.nodes / edges / flowId / flowName 是轉接到 store 的 getter/setter
        this.store = new FlowStore();
        this.history = new History(50);
        this.selectedNode = null;

        // 連線狀態
        this.connectionStart = null;
        this.isDraggingConnection = false;
        this.tempConnection = null;

        // n8n 風格連接拖拉狀態
        this.connectionDragState = {
            isDragging: false,
            sourceNodeId: null,
            sourceType: null, // 'output'
            sourceHandle: 'default',
            tempLine: null,
            mouseX: 0,
            mouseY: 0
        };

        // 畫布縮放
        this.canvasZoom = 1.0;

        // 框選功能
        this.selectedNodes = [];

        // ✅ Keyword cache（自動匹配用）
        this.keywordList = null;
        this.keywordListLoadTime = null;

        // Copy / Paste clipboard
        this.clipboard = null;

        // Search panel reference
        this.searchPanel = null;

        // Minimap references
        this.minimapEl = null;
        this.minimapCanvas = null;

        // 綁定事件處理函數
        this.boundUpdateConnectionDrag = this.updateConnectionDrag.bind(this);
        this.boundEndConnectionDrag = this.endConnectionDrag.bind(this);

        this.init();
    }

    /**
     * 初始化設計器
     */
    init() {
        this.createSvgLayer();
        this.setupEventListeners();
        this.loadFromLocalStorage();
        this.createMinimap();
        this.initNodePalette();
        // 目前畫面（含草稿）作為 undo 的起點
        this.history.reset(this.snapshot());
    }

    // ── store 轉接（相容既有程式碼對 this.nodes 等的讀寫） ──
    get nodes() { return this.store.nodes; }
    set nodes(v) { this.store.nodes = v; }
    get edges() { return this.store.edges; }
    set edges(v) { this.store.edges = v; }
    get flowId() { return this.store.flowId; }
    set flowId(v) { this.store.flowId = v; }
    get flowName() { return this.store.flowName; }
    set flowName(v) { this.store.flowName = v; }

    /** undo 與草稿用的可序列化快照 */
    snapshot() {
        return toPersisted({ nodes: this.nodes, edges: this.edges });
    }

    /** 整份換掉資料並重畫（載入、匯入、undo/redo、切換 bot） */
    _replaceFlow({ nodes = [], edges = [], flowId, flowName }) {
        this.store.replace({ nodes: hydrateNodes(nodes, NodeTypeConfig), edges, flowId, flowName });
        this.selectedNode = null;
        this.selectedNodes = [];
        this.renderAll();
    }
}

// 組裝 mixin：同名方法重複定義代表拆檔出錯，直接丟例外而不是默默覆蓋
for (const Mixin of DESIGNER_MIXINS) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(Mixin.prototype))) {
        if (name === 'constructor') continue;
        if (Object.prototype.hasOwnProperty.call(FlowDesigner.prototype, name)) {
            throw new Error(`[FlowDesigner] 方法重複定義：${name}（${Mixin.name}）`);
        }
        Object.defineProperty(FlowDesigner.prototype, name, descriptor);
    }
}

// 匯出供全域使用
export default FlowDesigner;

// =================================================================
// 🎯 pageInit - 頁面初始化函數（支援主頁面導航）
// =================================================================

/**
 * Flow Designer 頁面初始化函數
 * 
 * 用途：
 * 1. 讓 Flow Designer 可以從主頁面（index.html）導航進入
 * 2. 防止重複初始化
 * 3. 與其他 builder (richmenu, flex, imagemap) 保持一致
 * 
 * 呼叫時機：
 * - 從主頁面點擊「視覺化流程設計」
 * - 直接訪問 flow_designer_full.html
 * - 從其他頁面跳轉回來
 */
export async function pageInit() {

    // 防止重複初始化
    if (window._flowDesignerInitialized) {
        return;
    }

    try {
        // LIFF 初始化（取得 Bearer token 供 API 使用）
        // ⚠️ 注意：此頁從主頁以新分頁開啟，不可呼叫 liff.login()（會重定向離開本頁）。
        // 若在 LINE App 內且已登入：取得 profile 並更新 userId。
        // 若在桌機瀏覽器：略過登入，依賴主頁面已存入 localStorage 的 userId。
        if (configLiffId && typeof liff !== 'undefined') {
            try {
                const liffTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('LIFF init timeout')), 3000)
                );
                await Promise.race([liff.init({ liffId: configLiffId }), liffTimeout]);

                if (liff.isLoggedIn()) {
                    // 已登入（LINE App 環境）：取得最新 profile
                    const profile = await liff.getProfile();
                    if (profile?.userId) setUserId(profile.userId);
                }
                // 未登入（桌機瀏覽器）：不呼叫 liff.login()，讓 getUserId() 從 localStorage 讀取
            } catch (liffErr) {
                // 非 LIFF 環境或超時 — 繼續，依賴 localStorage userId
                console.warn('[Flow Designer] LIFF init skipped:', liffErr.message);
            }
        }

        // 初始化選擇器
        await initializeFlowSelectors();

        // 檢查容器是否存在
        const container = document.getElementById('flow-canvas');
        if (!container) {
            console.error('[Flow Designer] 找不到容器 #flow-canvas');
            return;
        }

        // 初始化 Flow Designer
        window.flowDesigner = new FlowDesigner('flow-canvas');
        // 靜態工具列按鈕（pages/flow_designer_full.html 的 data-on）
        bindActions(document.body, window.flowDesigner);
        window.flowDesigner.refreshPublishedStatus();

        // 標記已初始化
        window._flowDesignerInitialized = true;


    } catch (error) {
        console.error('❌ [Flow Designer] 初始化失敗:', error);
        window._flowDesignerInitialized = false;
    }
}

/**
 * 初始化 Flow Designer 的 Bot 和 Project 選擇器
 */
async function initializeFlowSelectors() {
    const botSelect = document.getElementById('flow-bot-select');
    const projectSelect = document.getElementById('flow-project-select');

    if (!botSelect) {
        return;
    }

    try {
        // 獲取 userId
        let userId = getUserId();

        // 如果沒有 userId，嘗試從 URL 參數獲取
        if (!userId) {
            const urlParams = new URLSearchParams(window.location.search);
            userId = urlParams.get('testUserId') || urlParams.get('userId');
        }

        if (!userId) {
            console.warn('[Flow Designer] 無法取得 userId');
            return;
        }

        // 載入 Bot 列表
        const botData = await api.get('/token/list');

        // 填充 Bot 下拉選單
        botSelect.innerHTML = '<option value="">選擇帳號...</option>'; // safe: static placeholder option
        Object.keys(botData).forEach(botName => {
            const option = document.createElement('option');
            option.value = botName;
            option.textContent = botName;
            botSelect.appendChild(option);
        });

        // 嘗試從 localStorage 獲取上次選擇的 Bot
        const savedBot = localStorage.getItem('flow_designer_bot');
        if (savedBot && botData[savedBot]) {
            botSelect.value = savedBot;
        } else if (Object.keys(botData).length > 0) {
            // 如果沒有保存的選擇，使用第一個
            botSelect.value = Object.keys(botData)[0];
        }

        // 同步選擇到後端
        if (botSelect.value) {
            await api.post('/token/set', { project: botSelect.value });
        }

        // Bot 切換事件
        botSelect.addEventListener('change', async (e) => {
            const newBot = e.target.value;
            if (!newBot) return;

            // 各 bot 的草稿分開保存，切換不會遺失畫布內容，不需再確認
            const previousBot = localStorage.getItem('flow_designer_bot');
            // 切換期間不可讓自動存檔把舊畫布存到新 bot
            if (window.flowDesigner) clearTimeout(window.flowDesigner._autoSaveTimer);
            let switched = false;

            try {
                // 保存選擇到 localStorage
                localStorage.setItem('flow_designer_bot', newBot);

                // 同步到後端
                await api.post('/token/set', { project: newBot });

                toast.info(`正在切換至 ${newBot}...`);

                if (window.flowDesigner) {
                    window.flowDesigner.switchBot(previousBot);
                    switched = true;
                    window.flowDesigner.refreshPublishedStatus();

                    // ✅ 清除 dataLoader 快取並重新載入新 Bot 的資料
                    if (window.dataLoader) {
                        window.dataLoader.clearCache();
                        await window.dataLoader.loadAllData();
                    }

                    toast.success(`已切換至 ${newBot}`);
                }
            } catch (err) {
                console.error('❌ 切換 LINE@ 失敗:', err);
                if (!switched) {
                    // 後端沒切成功：還原選擇，畫布與草稿維持原 bot
                    if (previousBot) localStorage.setItem('flow_designer_bot', previousBot);
                    else localStorage.removeItem('flow_designer_bot');
                    botSelect.value = previousBot || '';
                }
                toast.error('切換失敗，請稍後再試');
            }
        });

        // Project 選擇器 (目前是 placeholder，未來擴充)
        if (projectSelect) {
            projectSelect.addEventListener('change', (e) => {
                const newProject = e.target.value;
                // 未來實作：根據專案過濾流程
            });
        }


    } catch (err) {
        console.error('❌ [Flow Designer] 無法載入選擇器:', err);
    }
}

// 自動執行初始化（如果直接訪問此頁面）
if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', pageInit);
    } else {
        // DOM 已載入，立即執行
        pageInit();
    }
}

