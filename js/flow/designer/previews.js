// js/flow/designer/previews.js
// Previews：Flex 預覽、Richmenu/Imagemap 熱區繪製
// 以 mixin 方式掛到 FlowDesigner.prototype（見 js/flow_designer.js），方法內的 this 即 FlowDesigner 實例。

import { toast } from '../../../helper/toast.js';
import { escapeHtml } from './util.js';

export class PreviewsMethods {
    /**
     * 渲染 Flex Message 預覽
     */
    renderFlexPreview(contents) {
        if (!contents) return '';

        let preview = '';

        // Bubble 類型
        if (contents.type === 'bubble') {
            // Hero (圖片/影片)
            if (contents.hero) {
                preview += `<div style="font-size: 9px; color: #6c757d; padding: 2px 0;">📷 Hero 圖片</div>`;
            }

            // Body
            if (contents.body) {
                const bodyContents = contents.body.contents || [];
                const previewItems = bodyContents.slice(0, 2).map(item => {
                    if (item.type === 'text') {
                        const text = item.text || '';
                        const truncated = text.length > 20 ? text.substring(0, 20) + '...' : text;
                        return escapeHtml(truncated);
                    }
                    return `[${item.type}]`;
                });
                if (previewItems.length > 0) {
                    preview += `<div style="font-size: 9px; color: #495057; padding: 2px 0;">📝 ${previewItems.join(' ')}</div>`;
                }
            }

            // Footer (按鈕)
            if (contents.footer) {
                const buttons = contents.footer.contents || [];
                const buttonCount = buttons.length;
                if (buttonCount > 0) {
                    preview += `<div style="font-size: 9px; color: #6c757d; padding: 2px 0;">🔘 ${buttonCount} 個按鈕</div>`;
                }
            }
        }

        // Carousel 類型
        else if (contents.type === 'carousel') {
            const bubbles = contents.contents || [];
            preview += `<div style="font-size: 9px; color: #6c757d; padding: 2px 0;">🎠 ${bubbles.length} 個卡片</div>`;
        }

        return preview || '<div style="font-size: 9px; color: #adb5bd;">無預覽</div>';
    }

    /**
     * 繪製 Richmenu 按鈕區域
     */
    drawRichmenuButtons(nodeId, imageContainerId) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node || !node.data.buttons || node.data.buttons.length === 0) return;

        const container = document.getElementById(imageContainerId);
        if (!container) return;

        const img = container.querySelector('img');
        if (!img) return;

        // 移除舊的 canvas（如果存在）
        const oldCanvas = container.querySelector('canvas');
        if (oldCanvas) oldCanvas.remove();

        // 創建 canvas
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        `;

        const ctx = canvas.getContext('2d');

        // 取得原始 Richmenu 尺寸
        const originalWidth = node.data.size?.width || 2500;
        const originalHeight = node.data.size?.height || 1686;

        // 計算縮放比例
        const scaleX = img.width / originalWidth;
        const scaleY = img.height / originalHeight;

        // 繪製每個按鈕區域
        node.data.buttons.forEach((button, index) => {
            const bounds = button.bounds;
            if (!bounds) return;

            // 計算縮放後的坐標
            const x = bounds.x * scaleX;
            const y = bounds.y * scaleY;
            const width = bounds.width * scaleX;
            const height = bounds.height * scaleY;

            // 繪製紅色框框
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, width, height);

            // 繪製半透明背景
            ctx.fillStyle = 'rgba(231, 76, 60, 0.1)';
            ctx.fillRect(x, y, width, height);

            // 繪製按鈕序號（只顯示編號，不顯示詳細內容）
            const label = `${index + 1}`;

            // 繪製白色背景圓圈（序號）
            ctx.fillStyle = '#e74c3c';
            ctx.beginPath();
            ctx.arc(x + 15, y + 15, 12, 0, 2 * Math.PI);
            ctx.fill();

            // 繪製序號文字
            ctx.fillStyle = 'white';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x + 15, y + 15);

            // 在按鈕右側中央繪製連接點（輸出點）
            const outputX = x + width;
            const outputY = y + height / 2;

            // 繪製白色外圈
            ctx.fillStyle = '#e74c3c';
            ctx.beginPath();
            ctx.arc(outputX, outputY, 8, 0, 2 * Math.PI);
            ctx.fill();

            // 繪製白色邊框
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.stroke();

            // 繪製內部小點
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(outputX, outputY, 3, 0, 2 * Math.PI);
            ctx.fill();
        });

        container.appendChild(canvas);

        // 添加可點擊的連接點覆蓋層
        node.data.buttons.forEach((button, index) => {
            const bounds = button.bounds;
            if (!bounds) return;

            // 計算連接點位置
            const scaleX = img.width / originalWidth;
            const scaleY = img.height / originalHeight;
            const x = bounds.x * scaleX;
            const y = bounds.y * scaleY;
            const width = bounds.width * scaleX;
            const height = bounds.height * scaleY;
            const outputX = x + width;
            const outputY = y + height / 2;

            // 創建可點擊的連接點
            const connectionPoint = document.createElement('div');
            connectionPoint.className = 'richmenu-connection-point';
            connectionPoint.dataset.nodeId = nodeId;
            connectionPoint.dataset.output = button.id;
            connectionPoint.style.cssText = `
            position: absolute;
            left: ${outputX}px;
            top: ${outputY}px;
            width: 24px;
            height: 24px;
            transform: translate(-50%, -50%);
            cursor: pointer;
            z-index: 10;
            `;
            connectionPoint.title = `連接: ${button.label}`;
            connectionPoint.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.startConnectionDrag(nodeId, 'output', e, button.id);
            });

            container.appendChild(connectionPoint);
        });
    }

    /**
     * 繪製 Imagemap 可點擊區域
     */
    drawImagemapAreas(nodeId, imageContainerId) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node || !node.data.actions || node.data.actions.length === 0) return;

        const container = document.getElementById(imageContainerId);
        if (!container) return;

        const img = container.querySelector('img');
        if (!img) return;

        // 移除舊的 canvas（如果存在）
        const oldCanvas = container.querySelector('canvas');
        if (oldCanvas) oldCanvas.remove();

        // 創建 canvas
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        `;

        const ctx = canvas.getContext('2d');

        // 取得原始 Imagemap 尺寸
        const originalWidth = node.data.baseSize?.width || 1040;
        const originalHeight = node.data.baseSize?.height || 1040;

        // 計算縮放比例
        const scaleX = img.width / originalWidth;
        const scaleY = img.height / originalHeight;

        // 繪製每個可點擊區域
        node.data.actions.forEach((action, index) => {
            const area = action.area;
            if (!area) return;

            let x, y, width, height;

            // Imagemap area 是一個矩形區域 {x, y, width, height}
            if (area.x !== undefined && area.y !== undefined) {
                x = area.x * scaleX;
                y = area.y * scaleY;
                width = area.width * scaleX;
                height = area.height * scaleY;

                // 繪製藍色框框（區別於 Richmenu 的紅色）
                ctx.strokeStyle = '#3498db';
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, width, height);

                // 繪製半透明背景
                ctx.fillStyle = 'rgba(52, 152, 219, 0.1)';
                ctx.fillRect(x, y, width, height);

                // 繪製區域序號
                const label = `${index + 1}`;

                // 繪製藍色背景圓圈（序號）
                ctx.fillStyle = '#3498db';
                ctx.beginPath();
                ctx.arc(x + 15, y + 15, 12, 0, 2 * Math.PI);
                ctx.fill();

                // 繪製序號文字
                ctx.fillStyle = 'white';
                ctx.font = 'bold 14px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, x + 15, y + 15);

                // 在區域右側中央繪製連接點（輸出點）
                const outputX = x + width;
                const outputY = y + height / 2;

                // 繪製藍色外圈
                ctx.fillStyle = '#3498db';
                ctx.beginPath();
                ctx.arc(outputX, outputY, 8, 0, 2 * Math.PI);
                ctx.fill();

                // 繪製白色邊框
                ctx.strokeStyle = 'white';
                ctx.lineWidth = 2;
                ctx.stroke();

                // 繪製內部小點
                ctx.fillStyle = 'white';
                ctx.beginPath();
                ctx.arc(outputX, outputY, 3, 0, 2 * Math.PI);
                ctx.fill();
            }
        });

        container.appendChild(canvas);

        // 添加可點擊的連接點覆蓋層
        node.data.actions.forEach((action, index) => {
            const area = action.area;
            if (!area || area.x === undefined) return;

            // 計算連接點位置
            const scaleX = img.width / originalWidth;
            const scaleY = img.height / originalHeight;
            const x = area.x * scaleX;
            const y = area.y * scaleY;
            const width = area.width * scaleX;
            const height = area.height * scaleY;
            const outputX = x + width;
            const outputY = y + height / 2;

            // 創建可點擊的連接點
            const connectionPoint = document.createElement('div');
            connectionPoint.className = 'imagemap-connection-point';
            connectionPoint.dataset.nodeId = nodeId;
            connectionPoint.dataset.output = `action_${index}`;
            connectionPoint.style.cssText = `
                position: absolute;
                left: ${outputX}px;
                top: ${outputY}px;
                width: 16px;
                height: 16px;
                transform: translate(-50%, -50%);
                cursor: pointer;
                z-index: 10;
            `;
            connectionPoint.title = `連接: 區域 ${index + 1}`;
            connectionPoint.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.startConnectionDrag(nodeId, 'output', e, `action_${index}`);
            });

            container.appendChild(connectionPoint);
        });
    }

    /**
     * 顯示 Flex Message 完整預覽
     */
    showFlexPreview(nodeId) {
        const node = this.nodes.find(n => n.id === nodeId);
        if (!node || !node.data.contents) {
            toast.error('無法載入 Flex Message 資料');
            return;
        }

        // 取得 modal 元素
        const modal = document.getElementById('flexPreviewModal');
        const content = document.getElementById('flexPreviewContent');

        // 清空內容
        content.innerHTML = ''; // safe: clear

        try {
            // 檢查 flex2html 是否已載入
            if (typeof flex2html !== 'function') {
                toast.error('flex2html 尚未載入');
                console.error('flex2html function not found');
                return;
            }

            // 準備 Flex Message 資料
            const flexMessage = {
                type: 'flex',
                altText: node.data.altText || node.data.title || 'Flex Message',
                contents: node.data.contents
            };

            // 建立一個唯一的容器 ID
            const containerId = `flex-preview-${Date.now()}`;
            content.innerHTML = `<div id="${containerId}"></div>`; // safe: containerId = 'flex-preview-' + Date.now(), no user input

            // 使用 flex2html 渲染
            flex2html(containerId, flexMessage);

            // 顯示 modal
            const bsModal = new bootstrap.Modal(modal);
            bsModal.show();

            toast.success('Flex Message 已渲染');

        } catch (error) {
            console.error('Flex Message 渲染錯誤:', error);
            toast.error('Flex Message 渲染失敗: ' + error.message);
            {
                const errAlert = document.createElement('div');
                errAlert.className = 'alert alert-danger';
                errAlert.innerHTML = '<strong>渲染錯誤</strong><br>'; // safe: static text only
                const errMsg = document.createTextNode(error.message);
                errAlert.appendChild(errMsg);
                content.innerHTML = ''; // safe: clear
                content.appendChild(errAlert);
            }
        }
    }
}
