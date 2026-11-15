/**
 * 手機版側邊欄抽屜
 *
 * < 992px 時側邊欄收在畫面外（見 index.html 的 CSS），這裡負責開關：
 * 切換 body.sidebar-open。點遮罩、按 Esc、點選導覽項目、或視窗放大到桌機寬度都會關閉。
 * 純 DOM 操作，沒有任何 innerHTML。
 */
(function () {
  'use strict';

  var OPEN_CLASS = 'sidebar-open';
  var desktop = window.matchMedia('(min-width: 992px)');

  function init() {
    var toggle = document.getElementById('mobile-nav-toggle');
    var backdrop = document.getElementById('mobile-nav-backdrop');
    if (!toggle || !backdrop) return;

    function isOpen() {
      return document.body.classList.contains(OPEN_CLASS);
    }

    function setOpen(open) {
      document.body.classList.toggle(OPEN_CLASS, open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '關閉選單' : '開啟選單');
    }

    toggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });

    backdrop.addEventListener('click', function () {
      setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });

    // 點到實際的頁面連結才關（有 data-page 的）；展開子選單的 toggle 不該把抽屜收起來
    document.addEventListener('click', function (e) {
      var link = e.target.closest && e.target.closest('.sidebar-container .nav-link[data-page]');
      if (link && isOpen()) setOpen(false);
    });

    // 轉到橫向或放大到桌機寬度後，不要留著 body 的 overflow:hidden
    var onChange = function (e) {
      if (e.matches) setOpen(false);
    };
    if (desktop.addEventListener) desktop.addEventListener('change', onChange);
    else if (desktop.addListener) desktop.addListener(onChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
