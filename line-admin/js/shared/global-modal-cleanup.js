/**
 * 🔧 全局 Modal Backdrop 清理工具
 * 
 * 這個腳本會自動監聽所有 Bootstrap Modal 的關閉事件，
 * 並清理遺留的 backdrop 和 body 樣式。
 * 
 * 使用方式：在 HTML 中引入即可（在 Bootstrap 之後）
 * <script src="../js/shared/global-modal-cleanup.js"></script>
 * 
 * @author Antigravity AI
 * @since 2025-12-25
 */

(function () {
    'use strict';

    // 等待 DOM 和 Bootstrap 載入
    function init() {
        if (typeof bootstrap === 'undefined') {
            // Bootstrap 還沒載入，延遲初始化
            setTimeout(init, 50);
            return;
        }

        // 監聽所有 modal 的 hidden 事件
        document.addEventListener('hidden.bs.modal', function (event) {
            setTimeout(() => {
                // 檢查是否還有其他 modal 打開
                const hasOpenModal = document.querySelector('.modal.show');

                if (!hasOpenModal) {
                    // 移除所有遺留的 backdrop
                    const backdrops = document.querySelectorAll('.modal-backdrop');
                    if (backdrops.length > 0) {
                        backdrops.forEach(el => el.remove());
                    }

                    // 清理 body 樣式
                    document.body.classList.remove('modal-open');
                    document.body.style.removeProperty('overflow');
                    document.body.style.removeProperty('padding-right');
                }
            }, 100); // 100ms 延遲確保 Bootstrap 動畫完成
        });

    }

    // DOMContentLoaded 或立即執行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
