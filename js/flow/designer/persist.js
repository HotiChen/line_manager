// js/flow/designer/persist.js
// Persist：存讀後端、草稿、自動存檔、匯入匯出、清空、流程列表
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { ApiClient as api } from '../../../helper/api.client.js';
import { setInnerHTML } from '../../../helper/security.js';
import { showLoader, hideLoader } from '../../shared/loader.js';
import { toPersisted, parseImport, readDraft, writeDraft, clearDraft } from '../serialize.js';
import { escapeHtml, currentBot } from './util.js';

export class PersistMethods {
    /**
     * saveFlow
     * 儲存流程
     * 
     * Why (為什麼要這樣寫):
     * - 如果使用者按了多次 Ctrl+S 或多次點擊儲存，會在這瞬間發出好幾個儲存請求。防護鎖 `isSaving` 可確保畫面上只存一次。
     * 
     * Pre-conditions:
     * - `this.nodes` 和 `this.edges` 必須存在。
     * - 不允許並發執行。
     * 
     * Post-conditions:
     * - 從 API 獲取最新的 `flowId`。
     * - 將狀態保存在 LocalStorage 中。
     */
    async saveFlow() {
        if (this.isSaving) return;
        this.isSaving = true;
        // toPersisted：去掉 config 與執行期欄位、清掉懸空連線（後端會拒絕）
        const flowData = {
            id: this.flowId,
            name: this.flowName,
            ...toPersisted({ nodes: this.nodes, edges: this.edges })
        };

        try {
            const result = await api.post('/flow/save', flowData);
            this.flowId = result.flowId;

            // 只更新草稿：不可走 commit()，否則會再排一次自動存檔 → 每 30 秒無限重存
            this._writeDraft();
            this.isDirty = false;
            clearTimeout(this._autoSaveTimer);
            toast.success('✅ 流程已儲存');
        } catch (err) {
            console.error('儲存失敗:', err);
            toast.error('❌ 儲存失敗: ' + err.message);
        } finally {
            this.isSaving = false;
        }
    }

    /**
     * loadFlow
     * 載入流程
     * 
     * Why (為什麼要這樣寫):
     * - 避免網路卡頓時使用者多次點選載入不同流程，導致最後呈現出的畫面與預期狀態不同步。
     * 
     * Pre-conditions:
     * - 不可傳入空 `flowId`。
     * - 確保不在載入中。
     * 
     * Post-conditions:
     * - 從 API 獲取完整節點與連線設定並取代本地變數 (`this.nodes`, `this.edges`)。
     * - 觸發 `renderAll()` 更新 DOM 視圖。
     */
    async loadFlow(flowId) {
        if (!flowId) return;
        if (this.isLoading) return;
        this.isLoading = true;
        try {
            const data = await api.get(`/flow/get/${flowId}`);

            if (!data.flow) {
                throw new Error('流程資料不存在');
            }
            const flowData = data.flow;
            this._replaceFlow({
                nodes: flowData.nodes || [],
                edges: flowData.edges || [],
                flowId: flowData.id,
                flowName: flowData.name
            });
            this.history.reset(this.snapshot());
            this._writeDraft();
            this.isDirty = false;
            toast.success('✅ 流程已載入');
            this.refreshPublishedStatus();
        } catch (err) {
            console.error('載入失敗:', err);
            toast.error('❌ 載入失敗: ' + err.message);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * reloadFlow
     * 重新載入流程（刷新最新資料）
     * 
     * Why (為什麼要這樣寫):
     * - 在切換專案，或某些按鈕強制要求重新讀取關聯圖表（如 Richmenu 圖片）時使用。加入鎖定防止瘋狂重整。
     * 
     * Pre-conditions:
     * - 先確認是否已經載入中 (isLoading)
     * 
     * Post-conditions:
     * - 所有資料會被重置為遠端最新進度或 localStorage 的備份。
     */
    async reloadFlow() {
        if (this.isLoading) return;
        this.isLoading = true;
        try {
            showLoader('正在重新載入流程資料...');

            // 如果有 flowId，從後端載入
            if (this.flowId) {
                // ✅ 重新載入所有 Richmenu 節點的圖片資料
                await this.refreshAllRichmenuData();

                toast.success('✅ 流程已從後端重新載入');
            }
            // 如果沒有 flowId，從 localStorage 重新載入
            else {
                const draft = readDraft(localStorage, currentBot());
                if (draft) {
                    this._replaceFlow(draft);
                    this.history.reset(this.snapshot());

                    // ✅ 重新載入所有 Richmenu 節點的圖片資料
                    await this.refreshAllRichmenuData();

                    toast.success('✅ 流程已從本地重新載入');
                } else {
                    toast.warning('⚠️ 沒有可載入的流程資料');
                }
            }
        } catch (err) {
            console.error('重新載入失敗:', err);
            toast.error('❌ 重新載入失敗: ' + err.message);
        } finally {
            this.isLoading = false;
            hideLoader();
        }
    }

    /**
     * 儲存到 LocalStorage
     */
    /**
     * 變動完成的提交點：記 undo、寫草稿、標記未存、排自動存檔。
     * 所有修改流程的操作完成後都要呼叫（含直接改 node.data 的 editor）。
     * @param {{record?: boolean}} options record=false 用於 undo/redo 本身
     */
    commit({ record = true } = {}) {
        if (record) this.history.record(this.snapshot());
        this._writeDraft();
        this.isDirty = true;
        this.scheduleAutoSave();
    }

    /** 舊名稱，保留給既有呼叫點 */
    saveToLocalStorage() {
        this.commit();
    }

    _writeDraft() {
        writeDraft(localStorage, currentBot(), {
            nodes: this.nodes,
            edges: this.edges,
            flowId: this.flowId,
            flowName: this.flowName
        });
    }

    scheduleAutoSave() {
        if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
        this._autoSaveTimer = setTimeout(() => {
            if (this.flowId) {
                this.saveFlow();
            }
        }, 30000); // 30 秒無操作後自動儲存
    }

    exportFlow() {
        const data = JSON.stringify({
            name: this.flowName,
            ...toPersisted({ nodes: this.nodes, edges: this.edges }),
            exportedAt: new Date().toISOString()
        }, null, 2);
        
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.flowName || 'flow'}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    importFlow() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const result = parseImport(await file.text());
            if (!result.ok) {
                toast.error('匯入失敗：' + result.errors.slice(0, 3).join('；'));
                return;
            }
            // 匯入為新流程；可用 undo 回到匯入前
            this._replaceFlow({ ...result.flow, flowId: null, flowName: result.flow.name });
            this.commit();
            toast.success('流程已匯入');
        };
        input.click();
    }

    /**
     * 從 LocalStorage 載入
     */
    loadFromLocalStorage() {
        const draft = readDraft(localStorage, currentBot());
        if (draft) this._replaceFlow(draft);
    }

    /**
     * 切換 bot：存好目前草稿，換成新 bot 的草稿（沒有就空白畫布）
     * 呼叫前 localStorage 的 flow_designer_bot 必須已經是新 bot。
     */
    switchBot(previousBot) {
        writeDraft(localStorage, previousBot, {
            nodes: this.nodes, edges: this.edges, flowId: this.flowId, flowName: this.flowName
        });
        clearTimeout(this._autoSaveTimer);
        const draft = readDraft(localStorage, currentBot());
        this._replaceFlow(draft || { nodes: [], edges: [], flowId: null, flowName: '未命名流程' });
        this.history.reset(this.snapshot());
        this.isDirty = false;
        if (typeof this.hideSidebar === 'function') this.hideSidebar();
    }

    /**
     * 清空流程
     */
    clearFlow() {
        if (this.nodes.length > 0) {
            // 使用 Modal 確認對話框
            this.showConfirm(
                '清空畫布',
                '⚠️ 確定要清空畫布嗎？所有節點和連線都會被刪除，且無法復原。',
                () => this._executeClearFlow()
            );
        } else {
            // 畫布已經是空的，直接清空
            this._executeClearFlow();
        }
    }

    /**
     * 顯示確認對話框（使用 Bootstrap Modal）
     * @param {string} title - 標題
     * @param {string} message - 訊息
     * @param {Function} onConfirm - 確認後執行的回調函數
     */
    showConfirm(title, message, onConfirm) {
        const modal = document.getElementById('confirmModal');
        const modalTitle = document.getElementById('confirmModalTitle');
        const modalBody = document.getElementById('confirmModalBody');
        const confirmBtn = document.getElementById('confirmModalConfirm');

        if (!modal || !modalTitle || !modalBody || !confirmBtn) {
            console.error('[showConfirm] Modal 元素未找到');
            // 降級到原生 confirm
            if (window.confirm(message)) {
                onConfirm();
            }
            return;
        }

        // 設置內容
        modalTitle.textContent = title;
        setInnerHTML(modalBody, `<p class="mb-0">${message}</p>`);

        // 建立 Bootstrap Modal 實例
        const bsModal = new bootstrap.Modal(modal);

        // 移除舊的事件監聽器（如果有）
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

        // 綁定確認按鈕事件
        newConfirmBtn.addEventListener('click', () => {
            bsModal.hide();
            onConfirm();
        }, { once: true });

        // 顯示 Modal
        bsModal.show();
    }

    /**
     * 執行清空流程（內部方法）
     */
    _executeClearFlow() {
        this._replaceFlow({ nodes: [], edges: [], flowId: null, flowName: '未命名流程' });
        this.history.reset(this.snapshot());
        clearDraft(localStorage, currentBot());
        clearTimeout(this._autoSaveTimer);
        this.isDirty = false;

        toast.success('✅ 畫布已清空');
    }


    /**
     * 發布：先儲存，再請後端檢查並編譯；通過後 LINE 官方帳號就照這份流程執行。
     * 檢查沒過時，把有問題的節點標紅並跳到第一個。
     */
    async publishFlow() {
        if (this.isPublishing) return;
        this.isPublishing = true;
        try {
            await this.saveFlow();
            if (!this.flowId || this.isDirty) return; // 儲存失敗，saveFlow 已提示

            const res = await api.post(`/flow/publish/${this.flowId}`, {}, { rawResponse: true, showErrorToast: false });
            const data = await res.json().catch(() => ({}));

            if (res.ok) {
                toast.success('🚀 已發布，LINE 官方帳號現在照這個流程回覆');
                (data.warnings || []).slice(0, 3).forEach((w) => toast.warning(escapeHtml(String(w))));
                this.clearPublishErrors();
                await this.refreshPublishedStatus();
            } else if (res.status === 400 && Array.isArray(data.errors)) {
                this.showPublishErrors(data.errors);
            } else if (res.status === 403) {
                toast.error('只有 Bot 擁有者可以發布流程');
            } else {
                toast.error('發布失敗：' + (data.error || `HTTP ${res.status}`));
            }
        } catch (err) {
            toast.error('發布失敗：' + err.message);
        } finally {
            this.isPublishing = false;
        }
    }

    /** 取消發布：LINE 官方帳號回到只使用「關鍵字回覆」 */
    unpublishFlow() {
        this.showConfirm('取消發布', '取消後，LINE 官方帳號不再執行這個流程，改回只使用「關鍵字回覆」。確定嗎？', async () => {
            try {
                await api.delete('/flow/unpublish');
                toast.success('已取消發布');
                await this.refreshPublishedStatus();
            } catch (err) {
                toast.error('取消發布失敗：' + err.message);
            }
        });
    }

    clearPublishErrors() {
        document.querySelectorAll('.flow-node.publish-error').forEach((el) => el.classList.remove('publish-error'));
    }

    showPublishErrors(errors) {
        this.clearPublishErrors();
        const lines = errors.slice(0, 5).map((e) => {
            const node = e.nodeId ? this.store.getNode(e.nodeId) : null;
            const label = node ? (node.data.label || node.config?.label || node.type) : '';
            if (e.nodeId) document.getElementById(e.nodeId)?.classList.add('publish-error');
            return label ? `「${escapeHtml(String(label))}」${escapeHtml(e.message)}` : escapeHtml(e.message);
        });
        toast.error(`無法發布，請先修正：<br>${lines.join('<br>')}${errors.length > 5 ? `<br>…還有 ${errors.length - 5} 項` : ''}`);
        const first = errors.find((e) => e.nodeId && this.store.getNode(e.nodeId));
        if (first) this.focusOnNode(first.nodeId);
    }

    /** 更新工具列的發布狀態 */
    async refreshPublishedStatus() {
        const badge = document.getElementById('publish-status');
        const unpublishBtn = document.getElementById('unpublish-btn');
        if (!badge) return;
        try {
            const { published } = await api.get('/flow/published', { showErrorToast: false });
            this.published = published || null;
            if (!published) {
                badge.textContent = '未發布';
                badge.className = 'badge bg-secondary';
            } else {
                const mine = published.flowId === this.flowId;
                badge.textContent = mine ? '已發布（目前流程）' : `已發布：${published.name}`;
                badge.className = mine ? 'badge bg-success' : 'badge bg-warning text-dark';
                badge.title = `關鍵字：${(published.keywords || []).join('、')}\n發布時間：${new Date(published.publishedAt).toLocaleString()}`;
            }
            if (unpublishBtn) unpublishBtn.style.display = published ? '' : 'none';
        } catch {
            badge.textContent = '發布狀態未知';
            badge.className = 'badge bg-secondary';
        }
    }

    /**
     * 顯示流程列表 (✅ 已實作)
     */
    async showFlowList() {
        showLoader();
        try {
            const data = await api.get('/flow/list');
            const flows = data.flows || [];

            const modalId = `flow-list-modal-${Date.now()}`;
            document.querySelectorAll('[id^="flow-list-modal-"]').forEach(el => el.remove());
            document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            const modalHtml = `
                <div class="modal fade" id="${modalId}" tabindex="-1">
                    <div class="modal-dialog modal-lg">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title"><i class="bi bi-list-stars me-2"></i>我的流程列表</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <div class="modal-body">
                                ${flows.length === 0 ? '<div class="text-center p-5 text-muted">目前暫無儲存的流程</div>' : `
                                <div class="table-responsive">
                                    <table class="table table-hover align-middle">
                                        <thead>
                                            <tr>
                                                <th>流程名稱</th>
                                                <th>節點數</th>
                                                <th>更新時間</th>
                                                <th class="text-end">操作</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${flows.map(f => `
                                                <tr>
                                                    <td>
                                                        <div class="fw-bold">${escapeHtml(f.name)}${f.legacy ? ' <span class="badge bg-secondary" title="舊版資料，儲存一次即歸入目前的 Bot">未歸類</span>' : ''}</div>
                                                        <small class="text-muted font-monospace">${escapeHtml(f.id)}</small>
                                                    </td>
                                                    <td><span class="badge bg-info">${f.nodeCount}</span></td>
                                                    <td><small>${new Date(f.updatedAt).toLocaleString()}</small></td>
                                                    <td class="text-end">
                                                        <button class="btn btn-sm btn-primary btn-load-flow" data-id="${f.id}">
                                                            <i class="bi bi-folder2-open"></i> 載入
                                                        </button>
                                                        <button class="btn btn-sm btn-outline-danger btn-del-flow" data-id="${escapeHtml(f.id)}" data-name="${escapeHtml(f.name)}">
                                                            <i class="bi bi-trash"></i>
                                                        </button>
                                                    </td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                                `}
                            </div>
                        </div>
                    </div>
                </div>
            `;

            document.body.insertAdjacentHTML('beforeend', modalHtml);
            const modalEl = document.getElementById(modalId);
            const bsModal = new bootstrap.Modal(modalEl);

            // 綁定載入事件
            modalEl.querySelectorAll('.btn-load-flow').forEach(btn => {
                btn.onclick = async () => {
                    const id = btn.dataset.id;
                    bsModal.hide();
                    await this.loadFlow(id);
                };
            });

            // 綁定刪除事件
            modalEl.querySelectorAll('.btn-del-flow').forEach(btn => {
                btn.onclick = async () => {
                    const id = btn.dataset.id;
                    if (confirm(`確定要刪除流程「${btn.dataset.name}」嗎？此動作無法復原。`)) {
                        await api.delete(`/flow/delete/${id}`);
                        toast.success('流程已刪除');
                        bsModal.hide();
                        this.showFlowList(); // 重新整理
                    }
                };
            });

            modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());
            bsModal.show();
        } catch (err) {
            console.error('載入流程列表失敗:', err);
            toast.error('無法取得流程列表');
        } finally {
            hideLoader();
        }
    }
}
