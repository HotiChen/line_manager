/**
 * Flow Editor Page
 * 嵌入式流程設計器頁面初始化
 */

export function pageInit(pageData) {

  // 可以在這裡添加任何需要的初始化邏輯
  // iframe 會自動加載 flow_designer_full.html

  const iframe = document.getElementById('flow-designer-iframe');
  if (iframe) {
    iframe.onload = () => {
    };
  }
}
