// js/canvas.module.js

export const CanvasHelper = (() => {
    let canvas = null;
    let ctx = null;
    let scaleFactor = 1;
    let img = null;
  
    function init(c, context, scale, image) {
      if (!c || !context) {
        console.error("[CanvasHelper] 初始化失敗：canvas 或 context 為 null");
        return;
      }
      canvas = c;
      ctx = context;
      scaleFactor = scale;
      img = image;
    }
  
    function clearCanvas() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  
    function drawRectangles(areas = []) {
      areas.forEach((area, index) => {
        const { x, y, width, height } = area.area;
        const sx = x * scaleFactor;
        const sy = y * scaleFactor;
        const sw = width * scaleFactor;
        const sh = height * scaleFactor;
  
        ctx.fillStyle = "rgba(255, 0, 0, 0.3)";
        ctx.fillRect(sx, sy, sw, sh);
  
        ctx.strokeStyle = "#ff0000";
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, sw, sh);
  
        ctx.fillStyle = "#ff0000";
        ctx.font = "bold 24px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(index + 1, sx + sw / 2, sy + sh / 2);
      });
    }
  
    function redrawCanvasWithAreas(areas = []) {
      if (!ctx || !canvas) {
        console.error("[CanvasHelper] redrawCanvasWithAreas：尚未初始化 canvas 或 context");
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      drawRectangles(areas);
    }
  
    function isOverlap(a, b) {
      const r1 = a.area;
      const r2 = b.area;
      return (
        r1.x < r2.x + r2.width &&
        r1.x + r1.width > r2.x &&
        r1.y < r2.y + r2.height &&
        r1.y + r1.height > r2.y
      );
    }
  
    return {
      init,
      clearCanvas,
      drawRectangles,
      redrawCanvasWithAreas,
      isOverlap
    };
  })();