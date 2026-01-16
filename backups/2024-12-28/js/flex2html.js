import { setInnerHTML } from "../helper/security.js";

export function flex2html(element, json) {
   let carousel = carousel_struc()
   let result = ''

   if (json['type'] === 'flex') {
      json = json['contents']
      if (json['type'] === 'bubble') {
         result = bubble_object(json)
         carousel = carousel.replace('<!-- inner -->', result)
      } else if (json['type'] === 'carousel') {
         json['contents'].forEach((obj, index) => {
            let result = bubble_object(obj)
            result = result.replace('<!-- content -->', '')
            result = result.replace('<!-- inner -->', '')
            carousel = carousel.replace('<!-- inner -->', result + '<!-- inner -->')
         })
      }
   }

   const carouselWrapper = document.createElement("div");
   setInnerHTML(carouselWrapper, carousel);
   carousel = carouselWrapper.firstElementChild;
   const dom = carousel;
   document.getElementById(element).appendChild(dom);
   return dom;
}

export function bubble_object(json) {
   let { hero, header, body, footer } = json;

   let heroBox = '';
   if (hero?.type === 'video') {
      heroBox = hero_box_video(hero);
   } else if (hero?.type === 'image') {
      heroBox = convert_object('', hero);
   } else if (hero?.type === 'box' && hero?.contents?.length > 0) {
      heroBox = box_object(hero);
      heroBox = box_recursive(heroBox, hero.layout, hero.contents);
   }

   let headerBox = '';
   if (header?.type === 'box' && header?.contents?.length > 0) {
      headerBox = box_object(header);
      headerBox = box_recursive(headerBox, header.layout, header.contents);
   }

   let bodyBox = '';
   if (body?.type === 'box' && body?.contents?.length > 0) {
      bodyBox = box_object(body);
      bodyBox = box_recursive(bodyBox, body.layout, body.contents);
   }

   let footerBox = '';
   if (footer?.type === 'box' && footer?.contents?.length > 0) {
      footerBox = box_object(footer);
      footerBox = box_recursive(footerBox, footer.layout, footer.contents);
   }

   // 建立 DOM 結構
   const heroWrapper = document.createElement("div");
   setInnerHTML(heroWrapper, hero_struc(json));
   if (heroBox) heroWrapper.querySelector(".t1Hero")?.appendChild(heroBox);

   const headerWrapper = document.createElement("div");
   setInnerHTML(headerWrapper, header_struc(json));
   if (headerBox) headerWrapper.querySelector(".t1Header")?.appendChild(headerBox);

   const bodyWrapper = document.createElement("div");
   setInnerHTML(bodyWrapper, body_struc(json));
   if (bodyBox) bodyWrapper.querySelector(".t1Body")?.appendChild(bodyBox);

   const footerWrapper = document.createElement("div");
   setInnerHTML(footerWrapper, footer_struc(json));
   if (footerBox) footerWrapper.querySelector(".t1Footer")?.appendChild(footerBox);

   // 最外層 bubble
   const bubbleWrapper = document.createElement("div");
   setInnerHTML(bubbleWrapper, bubble_struc(json));
   const bubbleElement = bubbleWrapper.firstElementChild;

   bubbleElement.querySelector(".T1")?.append(
      headerWrapper.querySelector(".t1Header"),
      heroWrapper.querySelector(".t1Hero"),
      bodyWrapper.querySelector(".t1Body"),
      footerWrapper.querySelector(".t1Footer")
   );

   return bubbleElement;
}

export function hero_box_video(hero) {
   return `<div class="ExCover MdImg ExFull"><div><video width="100%" poster="${hero?.previewUrl}" controls>
   <source src="${hero?.url}" type="video/mp4">
   <source src="${hero?.url}" type="video/ogg">
   <source src="${hero?.url}" type="video/webm">
</video></div></div>`
}
export function box_recursive(parent_box, layout, json) {
   if (!json || json.length === 0) {
      console.warn("❗ 忽略空 box", parent_box);
      return parent_box;
   }

   let result = []
   let layout2;
   json.forEach((obj, index) => {
      let temp
      if (obj['type'] === 'box') {
         if (!obj['contents'] || obj['contents'].length === 0) {
            console.warn("🚫 巢狀空 box 忽略", obj);
            return; // 不加入 result
         }
         let temp2 = box_object(obj)
         layout2 = obj['layout']
         temp = box_recursive(temp2, layout2, obj['contents'])
      } else if (obj['type'] === 'text' && obj['contents'] && obj['contents'].length > 0) {
         let temp2 = convert_object(layout, obj)
         layout2 = obj['layout']
         temp = box_recursive(temp2, layout2, obj['contents'])
      } else {
         temp = convert_object(layout, obj)
      }
      result[index] = temp
   })


   json.forEach((obj, index) => {
      if (result[index] instanceof Node) {
         parent_box.appendChild(result[index]);
      }
   });

   return parent_box
}

export function convert_object(layout, json) {
   let object;
   switch (json['type']) {
      case 'image':
         object = image_object(json)
         break;
      case 'icon':
         object = icon_object(json)
         break;
      case 'text':
         object = text_object(json)
         break;
      case 'span':
         object = span_object(json)
         break;
      case 'button':
         object = button_object(json)
         break;
      case 'filler':
         object = filler_object(json)
         break;
      case 'spacer':
         object = spacer_object(json)
         break;
      case 'separator':
         object = separator_object(layout, json)
         break;
      default:
         object = null
   }
   // 將 HTML 字串轉為 DOM 元素
   if (typeof object === 'string') {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, object);
      object = wrapper.firstElementChild;
   }
   return object
}

export function box_object(json) {
   let style = ''
   let { layout, position, flex, spacing, margin, width, height, backgroundColor, borderColor, borderWidth, cornerRadius, justifyContent, alignItems, offsetTop, offsetBottom, offsetStart, offsetEnd, paddingAll, paddingTop, paddingBottom, paddingStart, paddingEnd, background, maxWidth, maxHeight } = json
   let layout1 = '', layout2 = '', fl = '', exabs = '', spc = '', exmgn = '';
   let ExBdr = '', ExBdrRad = '', jfc = '', alg = '';
   let ext = '', exb = '', exl = '', exr = '';
   let ExPadA = '', ExPadT = '', ExPadB = '', ExPadL = '', ExPadR = '';
   let centerPosition = '';

   if (layout === 'baseline') {
      layout1 = 'hr'
      layout2 = 'bl'
   } else if (layout === 'horizontal') {
      layout1 = 'hr'
      layout2 = ''
   } else if (layout === 'vertical') {
      layout1 = 'vr'
      layout2 = ''
   }
   fl = ''
   if (flex > 3) {
      style += `-webkit-box-flex:${flex};flex-grow:${flex};`
   } else {
      fl = (flex >= 0) ? `fl${flex}` : ''
   }
   exabs = (position === 'absolute') ? 'ExAbs' : ''

   if (spacing && spacing.indexOf("px") >= 0) {
      spc = ''
   } else {
      spc = (spacing) ? 'spc' + upperalldigit(spacing) : ''
   }

   if (margin && margin.indexOf("px") >= 0) {
      style += `margin-top:${margin};`
      exmgn = ''
   } else {
      exmgn = (margin) ? 'ExMgnT' + upperalldigit(margin) : ''
   }
   if (width && width !== '') {
      style += `width:${width}; max-width:${width};`
   }
   if (height && height !== '') {
      style += `height:${height};`
   }
   if (backgroundColor) {
      style += `background-color:${backgroundColor} !important;`
   }
   if (borderColor) {
      style += `border-color:${borderColor} !important;`
   }

   if (borderWidth && borderWidth.indexOf("px") >= 0) {
      style += `border-width:${borderWidth};`
      ExBdr = ''
   } else {
      switch (borderWidth) {
         case 'none':
            ExBdr = 'ExBdrWdtNone'
            break;
         case 'light':
            ExBdr = 'ExBdrWdtLgh'
            break;
         case 'normal':
            ExBdr = 'ExBdrWdtNml'
            break;
         case 'medium':
            ExBdr = 'ExBdrWdtMdm'
            break;
         case 'semi-bold':
            ExBdr = 'ExBdrWdtSbd'
            break;
         case 'bold':
            ExBdr = 'ExBdrWdtBld'
            break;
         default:
            ExBdr = ''
         // code block
      }
   }
   if (cornerRadius && cornerRadius.indexOf("px") >= 0) {
      style += `border-radius:${cornerRadius};`
      ExBdrRad = ''
   } else {
      ExBdrRad = (cornerRadius) ? 'ExBdrRad' + upperalldigit(cornerRadius) : ''
   }

   jfc = ''
   if (justifyContent && justifyContent !== '') {
      switch (justifyContent) {
         case 'center':
            jfc = 'itms-jfcC'
            break;
         case 'flex-start':
            jfc = 'itms-jfcS'
            break;
         case 'flex-end':
            jfc = 'itms-jfcE'
            break;
         case 'space-between':
            jfc = 'itms-jfcSB'
            break;
         case 'space-around':
            jfc = 'itms-jfcSA'
            break;
         case 'space-evenly':
            jfc = 'itms-jfcSE'
            break;
         default:
            jfc = ''
         // code block
      }
   }
   alg = ''
   if (alignItems && alignItems !== '') {
      switch (alignItems) {
         case 'center':
            alg = 'itms-algC'
            break;
         case 'flex-start':
            alg = 'itms-algS'
            break;
         case 'flex-end':
            alg = 'itms-algE'
            break;
         default:
            alg = ''
         // code block
      }
   }
   if (offsetTop && offsetTop.indexOf("px") >= 0) {
      style += `top:${offsetTop};`
      ext = ''
   } else {
      ext = (offsetTop) ? 'ExT' + upperalldigit(offsetTop) : ''
   }

   if (offsetBottom && offsetBottom.indexOf("px") >= 0) {
      style += `bottom:${offsetBottom};`
      exb = ''
   } else {
      exb = (offsetBottom) ? 'ExB' + upperalldigit(offsetBottom) : ''
   }

   if (offsetStart && offsetStart.indexOf("px") >= 0) {
      style += `left:${offsetStart};`
      exl = ''
   } else {
      exl = (offsetStart) ? 'ExL' + upperalldigit(offsetStart) : ''
   }

   if (offsetEnd && offsetEnd.indexOf("px") >= 0) {
      style += `right:${offsetEnd};`
      exr = ''
   } else {
      exr = (offsetEnd) ? 'ExR' + upperalldigit(offsetEnd) : ''
   }

   if (paddingAll && paddingAll.indexOf("px") >= 0) {
      style += `padding:${paddingAll};`
      ExPadA = ''
   } else {
      ExPadA = (paddingAll) ? 'ExPadA' + upperalldigit(paddingAll) : ''
   }

   if (paddingTop && paddingTop.indexOf("px") >= 0) {
      style += `padding-top:${paddingTop};`
      ExPadT = ''
   } else {
      ExPadT = (paddingTop) ? 'ExPadT' + upperalldigit(paddingTop) : ''
   }

   if (paddingBottom && paddingBottom.indexOf("px") >= 0) {
      style += `padding-bottom:${paddingBottom};`
      ExPadB = ''
   } else {
      ExPadB = (paddingBottom) ? 'ExPadB' + upperalldigit(paddingBottom) : ''
   }

   if (paddingStart && paddingStart.indexOf("px") >= 0) {
      style += `padding-left:${paddingStart};`
      ExPadL = ''
   } else {
      ExPadL = (paddingStart) ? 'ExPadL' + upperalldigit(paddingStart) : ''
   }

   if (paddingEnd && paddingEnd.indexOf("px") >= 0) {
      style += `padding-right:${paddingEnd};`
      ExPadR = ''
   } else {
      ExPadR = (paddingEnd) ? 'ExPadR' + upperalldigit(paddingEnd) : ''
   }

   if (background && background.type === 'linearGradient') {
      centerPosition = (background.centerPosition) ? background.centerPosition : '50%'
      if (background.centerColor) {
         style += `background: linear-gradient(${background.angle}, ${background.startColor} 0%, ${background.centerColor} ${centerPosition}, ${background.endColor} 100%);`
      } else {
         style += `background: linear-gradient(${background.angle}, ${background.startColor} 0%, ${background.endColor} 100%);`
      }
   }
   if (maxWidth && maxWidth.indexOf("px") >= 0) {
      style += `max-width:${maxWidth};`
   }
   if (maxHeight && maxHeight.indexOf("px") >= 0) {
      style += `max-height:${maxHeight};`
   }


   const wrapper = document.createElement("div");
   setInnerHTML(wrapper, `<div class="MdBx flex-element ${layout1} ${layout2} ${fl} ${exabs} ${exmgn} ${spc} ${ExBdr} ${ExBdrRad} ${jfc} ${alg} ${ext} ${exb} ${exl} ${exr} ${ExPadA} ${ExPadT} ${ExPadB} ${ExPadL} ${ExPadR}" data-flex-type="box" style="${style}"></div>`);
   return wrapper.firstElementChild;

}

export function button_object(json) {
   let style2 = ''
   let style3 = ''
   let { flex, margin, position, height, style, color, gravity, adjustMode, offsetTop, offsetBottom, offsetStart, offsetEnd, action } = json
   let fl = '', exabs = '', exmgn = '', grv = '';
   let heightClass = '', ExBtn = '', ext = '', exb = '', exl = '', exr = '';
   fl = ''
   if (flex > 3) {
      style2 += `-webkit-box-flex:${flex};flex-grow:${flex};`
   } else {
      fl = (flex >= 0) ? `fl${flex}` : ''
   }
   exabs = (position === 'absolute') ? 'ExAbs' : ''

   if (margin && margin.indexOf("px") >= 0) {
      style2 += `margin-top:${margin};`
      exmgn = ''
   } else {
      exmgn = (margin) ? 'ExMgnT' + upperalldigit(margin) : ''
   }

   heightClass = (!height || height === '' || height === 'md') ? '' : 'Ex' + upperalldigit(height);
   grv = (gravity === 'bottom' || gravity === 'center') ? 'grv' + upper1digit(gravity) : '';

   ExBtn = 'ExBtnL'
   if (style && style !== '') {
      switch (style) {
         case 'link':
            ExBtn = 'ExBtnL'
            break;
         case 'primary':
            ExBtn = 'ExBtn1'
            break;
         case 'secondary':
            ExBtn = 'ExBtn2'
            break;
         default:
            ExBtn = 'ExBtnL'
         // code block
      }
   }

   if (color) {
      style3 += (style === 'link') ? `color:${color} !important;` : `background-color:${color} !important;`
   }

   if (json.style && json.style.backgroundColor) {
      style3 += `background-color:${json.style.backgroundColor} !important;`
   }

   if (offsetTop && offsetTop.indexOf("px") >= 0) {
      style2 += `top:${offsetTop};`
      ext = ''
   } else {
      ext = (offsetTop) ? 'ExT' + upperalldigit(offsetTop) : ''
   }

   if (offsetBottom && offsetBottom.indexOf("px") >= 0) {
      style2 += `bottom:${offsetBottom};`
      exb = ''
   } else {
      exb = (offsetBottom) ? 'ExB' + upperalldigit(offsetBottom) : ''
   }

   if (offsetStart && offsetStart.indexOf("px") >= 0) {
      style2 += `left:${offsetStart};`
      exl = ''
   } else {
      exl = (offsetStart) ? 'ExL' + upperalldigit(offsetStart) : ''
   }

   if (offsetEnd && offsetEnd.indexOf("px") >= 0) {
      style2 += `right:${offsetEnd};`
      exr = ''
   } else {
      exr = (offsetEnd) ? 'ExR' + upperalldigit(offsetEnd) : ''
   }

   action = (!action) ? { 'type': 'none' } : action
   if (action.type === 'uri') {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="MdBtn flex-element ${ExBtn} ${heightClass} ${fl} ${exabs} ${exmgn} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="button" data-action-type="${action.type}" style="${style2}"><a href="${action.uri}" target="_blank" data-action-type="uri" data-action-label="${action.label ?? ''}" data-action-uri="${action.uri ?? ''}" style="${style3}"><div>${action.label}</div></a></div>`);
      return wrapper.firstElementChild;
   } else if (action.type === 'message') {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="MdBtn flex-element ${ExBtn} ${heightClass} ${fl} ${exabs} ${exmgn} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="button" data-action-type="${action.type}" style="${style2}"><a href="#" data-action-type="message" data-action-label="${action.label ?? ''}" data-action-text="${action.text ?? ''}" style="${style3}"><div>${action.label}</div></a></div>`);
      return wrapper.firstElementChild;
   } else if (action.type === 'postback') {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="MdBtn flex-element ${ExBtn} ${heightClass} ${fl} ${exabs} ${exmgn} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="button" data-action-type="${action.type}" style="${style2}"><a href="#" data-action-type="postback" data-action-label="${action.label ?? ''}" data-action-data="${(action.data ?? '').toString().replace(/"/g, '&quot;')}" style="${style3}"><div>${action.label}</div></a></div>`);
      return wrapper.firstElementChild;
   } else {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="MdBtn flex-element ${ExBtn} ${heightClass} ${fl} ${exabs} ${exmgn} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="button" data-action-type="${action.type}" style="${style2}"><a href="#" data-action-type="none" data-action-label="${action.label ?? ''}" style="${style3}"><div>${action.label}</div></a></div>`);
      return wrapper.firstElementChild;
   }
}
export function filler_object(json) {
   let style = '';
   let fl = '';
   let { flex } = json;
   fl = ''
   if (flex > 3) {
      style += `-webkit-box-flex:${flex};flex-grow:${flex};`
   } else {
      fl = (flex >= 0) ? `fl${flex}` : ''
   }
   const wrapper = document.createElement("div");
   setInnerHTML(wrapper, `<div class="mdBxFiller ${fl}" style="${style}" ></div>`);
   return wrapper.firstElementChild;
}
export function icon_object(json) {
   let style2 = ''
   let { size, aspectRatio, url, position, margin, offsetTop, offsetBottom, offsetStart, offsetEnd } = json
   let styleimg = `background-image:url('${url}');`
   let exabs = '', exmgn = '', ext = '', exb = '', exl = '', exr = '';
   let ratio;


   size = (!size || size === '') ? 'md' : size
   if (size.indexOf("px") >= 0) {
      style2 += `font-size:${size};`
      size = ''
   } else {
      size = 'Ex' + upperalldigit(size)
   }

   if (!aspectRatio || aspectRatio === '') {
      styleimg += `width:1em;`
   } else {
      ratio = ratio[0] / ratio[1]
      styleimg += `width:${ratio}em;`
   }
   exabs = (position === 'absolute') ? 'ExAbs' : ''

   if (margin && margin.indexOf("px") >= 0) {
      style2 += `margin-top:${margin};`
      exmgn = ''
   } else {
      exmgn = (margin) ? 'ExMgnT' + upperalldigit(margin) : ''
   }

   if (offsetTop && offsetTop.indexOf("px") >= 0) {
      style2 += `top:${offsetTop};`
      ext = ''
   } else {
      ext = (offsetTop) ? 'ExT' + upperalldigit(offsetTop) : ''
   }

   if (offsetBottom && offsetBottom.indexOf("px") >= 0) {
      style2 += `bottom:${offsetBottom};`
      exb = ''
   } else {
      exb = (offsetBottom) ? 'ExB' + upperalldigit(offsetBottom) : ''
   }

   if (offsetStart && offsetStart.indexOf("px") >= 0) {
      style2 += `left:${offsetStart};`
      exl = ''
   } else {
      exl = (offsetStart) ? 'ExL' + upperalldigit(offsetStart) : ''
   }

   if (offsetEnd && offsetEnd.indexOf("px") >= 0) {
      style2 += `right:${offsetEnd};`
      exr = ''
   } else {
      exr = (offsetEnd) ? 'ExR' + upperalldigit(offsetEnd) : ''
   }

   const wrapper = document.createElement("div");
   setInnerHTML(wrapper, `<div class="MdIco fl0 ${size} ${exabs} ${exmgn} ${ext} ${exb} ${exl} ${exr}" style="${style2}" ><div><span style="${styleimg}"></span></div></div>`);
   return wrapper.firstElementChild;
}
export function image_object(json) {
   let style = ''
   let style2 = ''
   let fl = '', exabs = '', exmgn = '', alg = '', grv = '';
   let ext = '', exb = '', exl = '', exr = '';
   let { aspectMode, size, aspectRatio, url, position, flex, margin, align, gravity, backgroundColor, offsetTop, offsetBottom, offsetStart, offsetEnd, action } = json
   let styleimg = `background-image:url('${url}');`
   if (backgroundColor) {
      styleimg += `background-color:${backgroundColor} !important;`
   }

   aspectMode = (!aspectMode || aspectMode === '') ? 'fit' : aspectMode
   size = (!size || size === '') ? 'md' : size
   aspectMode = upperalldigit(aspectMode)
   if (size.indexOf("px") >= 0) {
      style2 += `width:${size};`
      size = ''
   } else if (size.indexOf("%") >= 0) {
      style2 += `width:${size};`
      size = ''
   } else {
      size = 'Ex' + upperalldigit(size)
   }

   let ratio;
   if (!aspectRatio || aspectRatio === '') {
      ratio = 100;
   } else {
      const parts = aspectRatio.split(':');
      ratio = (parseFloat(parts[1]) * 100) / parseFloat(parts[0]);
   }
   fl = ''
   if (flex > 3) {
      style += `-webkit-box-flex:${flex};flex-grow:${flex};`
   } else {
      fl = (flex >= 0) ? `fl${flex}` : ''
   }
   exabs = (position === 'absolute') ? 'ExAbs' : ''

   if (margin && margin.indexOf("px") >= 0) {
      style += `margin-top:${margin};`
      exmgn = ''
   } else {
      exmgn = (margin) ? 'ExMgnT' + upperalldigit(margin) : ''
   }

   alg = (align === 'start' || align === 'end') ? 'alg' + upper1digit(align) : '';
   grv = (gravity === 'bottom' || gravity === 'center') ? 'grv' + upper1digit(gravity) : '';

   if (offsetTop && offsetTop.indexOf("px") >= 0) {
      style += `top:${offsetTop};`
      ext = ''
   } else {
      ext = (offsetTop) ? 'ExT' + upperalldigit(offsetTop) : ''
   }

   if (offsetBottom && offsetBottom.indexOf("px") >= 0) {
      style += `bottom:${offsetBottom};`
      exb = ''
   } else {
      exb = (offsetBottom) ? 'ExB' + upperalldigit(offsetBottom) : ''
   }

   if (offsetStart && offsetStart.indexOf("px") >= 0) {
      style += `left:${offsetStart};`
      exl = ''
   } else {
      exl = (offsetStart) ? 'ExL' + upperalldigit(offsetStart) : ''
   }

   if (offsetEnd && offsetEnd.indexOf("px") >= 0) {
      style += `right:${offsetEnd};`
      exr = ''
   } else {
      exr = (offsetEnd) ? 'ExR' + upperalldigit(offsetEnd) : ''
   }
   action = (!action) ? { 'type': 'none' } : action
   if (action.type === 'uri') {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="flex-element flex-image MdImg Ex${aspectMode} ${fl} ${size} ${exabs} ${exmgn} ${alg} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="image" style="${style}">
                 <div style="${style2}">
                    <a href="${action.uri}" target="_blank" data-action-type="uri" data-action-label="${action.label ?? ''}" data-action-uri="${action.uri ?? ''}" style="padding-bottom:${ratio}%;">
                        <span style="${styleimg}"></span>
                     </a>
                  </div>
               </div>`);
      return wrapper.firstElementChild;
   } else if (action.type === 'message') {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="flex-element flex-image MdImg Ex${aspectMode} ${fl} ${size} ${exabs} ${exmgn} ${alg} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="image" style="${style}">
                 <div style="${style2}">
                    <a href="#" data-action-type="message" data-action-label="${action.label ?? ''}" data-action-text="${action.text ?? ''}" style="padding-bottom:${ratio}%;">
                        <span style="${styleimg}"></span>
                     </a>
                  </div>
               </div>`);
      return wrapper.firstElementChild;
   } else if (action.type === 'postback') {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="flex-element flex-image MdImg Ex${aspectMode} ${fl} ${size} ${exabs} ${exmgn} ${alg} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="image" style="${style}">
                 <div style="${style2}">
                    <a href="#" data-action-type="postback" data-action-label="${action.label ?? ''}" data-action-data="${(action.data ?? '').toString().replace(/"/g, '&quot;')}" style="padding-bottom:${ratio}%;">
                        <span style="${styleimg}"></span>
                     </a>
                  </div>
               </div>`);
      return wrapper.firstElementChild;
   } else {
      const wrapper = document.createElement("div");
      setInnerHTML(wrapper, `<div class="flex-element flex-image MdImg Ex${aspectMode} ${fl} ${size} ${exabs} ${exmgn} ${alg} ${grv} ${ext} ${exb} ${exl} ${exr}" data-flex-type="image" style="${style}">
                  <div style="${style2}">
                     <a style="padding-bottom:${ratio}%;">
                        <span style="${styleimg}"></span>
                     </a>
                  </div>
               </div>`);
      return wrapper.firstElementChild;
   }


}
export function separator_object(layout, json) {
   let exmgn = '';
   let style = ''
   let { margin, color } = json

   if (margin && margin.indexOf("px") >= 0) {
      style += (layout === 'vertical') ? `margin-top:${margin};` : `margin-left:${margin};`
      exmgn = ''
   } else {
      exmgn = (margin) ? 'ExMgnT' + upperalldigit(margin) : ''
   }
   if (color) {
      style += `border-color:${color} !important;`
   }

   const wrapper = document.createElement("div");
   setInnerHTML(wrapper, `<div class="fl0 MdSep ${exmgn}" style="${style}" ></div>`);
   return wrapper.firstElementChild;
}
export function spacer_object(json) {
   let { size } = json
   size = (!size || size === '') ? 'md' : size
   if (size.indexOf("px") >= 0) {
      size = ''
   } else {
      size = 'spc' + upperalldigit(size)
   }
   return `<div class="mdBxSpacer ${size} fl0" ></div>`
}
export function span_object(json) {
   let ExWB = '', ExFntSty = '', ExTxtDec = '';
   let style2 = '';
   let { text, size, color, weight, style, decoration } = json

   if (size && size !== '') {
      if (size.indexOf("px") >= 0) {
         style2 += `font-size:${size};`
         size = ''
      } else {
         size = 'Ex' + upperalldigit(size)
      }
   } else {
      size = ''
   }

   if (color && color !== '') {
      style2 += `color:${color};`
   }
   ExWB = (weight === 'bold') ? 'ExWB' : ''
   ExFntSty = (style === 'normal') ? 'ExFntStyNml' : (style === 'italic') ? 'ExFntStyIt' : ''
   ExTxtDec = (decoration === 'line-through') ? 'ExTxtDecLt' : (decoration === 'underline') ? 'ExTxtDecUl' : (decoration === 'none') ? 'ExTxtDecNone' : ''

   return `<span class="MdSpn ${ExWB} ${size} ${ExFntSty} ${ExTxtDec}" style="${style2}" >${text}</span>`
}
export function carousel_struc() {
   return `<div class="LySlider"><div class="lyInner"><!-- inner --></div></div><br>`
}

export function bubble_struc(json) {
   let { size, direction, action } = json
   size = (!size || size === '') ? 'medium' : size
   direction = (!direction || direction == '') ? 'ltr' : direction
   size = upper2digit(size)

   return `<div class="lyItem Ly${size}" style="width: 100%; max-width: 360px; min-width: 320px;"><div class="T1 fx${direction.toUpperCase()}" dir="${direction}"><!-- header --><!-- hero --><!-- body --><!-- footer --></div></div>`
}
export function hero_struc(json) {
   let { styles } = json
   let backgroundColor = ''
   if (styles) {
      let { hero } = styles
      backgroundColor = (hero && hero.backgroundColor) ? `background-color:${hero.backgroundColor}` : ''
   }
   return `<div class="t1Hero" style="${backgroundColor}"><!-- inner --></div>`
}
export function header_struc(json) {
   let { styles } = json
   let backgroundColor = ''
   if (styles) {
      let { header } = styles
      backgroundColor = (header && header.backgroundColor) ? `background-color:${header.backgroundColor}` : ''
   }
   return `<div class="t1Header" style="${backgroundColor}"><!-- inner --></div>`
}
export function body_struc(json) {
   let { footer, styles } = json
   let backgroundColor = ''
   if (styles) {
      let { body } = styles
      backgroundColor = (body && body.backgroundColor) ? `background-color:${body.backgroundColor}` : ''
   }
   let ExHasFooter = (footer) ? 'ExHasFooter' : ''
   return `<div class="t1Body ${ExHasFooter}" style="${backgroundColor}"><!-- inner --></div>`
}
export function footer_struc(json) {
   let { styles } = json
   let backgroundColor = ''
   if (styles) {
      let { footer } = styles
      backgroundColor = (footer && footer.backgroundColor) ? `background-color:${footer.backgroundColor}` : ''
   }
   return `<div class="t1Footer" style="${backgroundColor}"><!-- inner --></div>`
}
function isGrayish(color) {
   if (!color || !color.startsWith('#') || color.length < 4) return false;
   const hex = color.substring(1);
   if (hex.length === 3) {
      const c = hex.split('').map(ch => ch + ch).join('');
      return /^([0-9a-f]{2})\1\1$/i.test(c);
   }
   if (hex.length === 6) {
      return /^([0-9a-f]{2})\1\1$/i.test(hex);
   }
   return false;
}

export function text_object(json) {

   let fl = '', exabs = '', exmgn = '', alg = '', grv = '';
   let ExWB = '', ExFntSty = '', ExTxtDec = '', ExWrap = '';
   let ext = '', exb = '', exl = '', exr = '';
   let style2 = ''
   let { flex, margin, size, position, align, gravity, text, color, weight, style, decoration, wrap, maxLines, adjustMode, offsetTop, offsetBottom, offsetStart, offsetEnd, lineSpacing } = json

   fl = ''
   if (flex > 3) {
      style2 += `-webkit-box-flex:${flex};flex-grow:${flex};`
   } else {
      fl = (flex >= 0) ? `fl${flex}` : ''
   }
   exabs = (position === 'absolute') ? 'ExAbs' : ''

   if (margin && margin.indexOf("px") >= 0) {
      style2 += `margin-top:${margin};`
      exmgn = ''
   } else {
      exmgn = (margin) ? 'ExMgnL' + upperalldigit(margin) : ''
   }

   alg = (align === 'start' || align === 'end' || align === 'center') ? 'ExAlg' + upper1digit(align) : '';
   grv = (gravity === 'bottom' || gravity === 'center') ? 'grv' + upper1digit(gravity) : '';
   size = (!size || size === '') ? 'md' : size
   if (size.indexOf("px") >= 0) {
      style2 += `font-size:${size};`
      size = ''
   } else {
      size = 'Ex' + upperalldigit(size)
   }

   if (color && color !== '') {
      style2 += `color:${color};`
   }
   ExWB = (weight === 'bold') ? 'ExWB' : ''
   ExFntSty = (style === 'normal') ? 'ExFntStyNml' : (style === 'italic') ? 'ExFntStyIt' : ''
   ExTxtDec = (decoration === 'line-through') ? 'ExTxtDecLt' : (decoration === 'underline') ? 'ExTxtDecUl' : (decoration === 'none') ? 'ExTxtDecNone' : ''
   ExWrap = (wrap === true) ? 'ExWrap' : ''
   if (offsetTop && offsetTop.indexOf("px") >= 0) {
      style2 += `top:${offsetTop};`
      ext = ''
   } else {
      ext = (offsetTop) ? 'ExT' + upperalldigit(offsetTop) : ''
   }

   if (offsetBottom && offsetBottom.indexOf("px") >= 0) {
      style2 += `bottom:${offsetBottom};`
      exb = ''
   } else {
      exb = (offsetBottom) ? 'ExB' + upperalldigit(offsetBottom) : ''
   }

   if (offsetStart && offsetStart.indexOf("px") >= 0) {
      style2 += `left:${offsetStart};`
      exl = ''
   } else {
      exl = (offsetStart) ? 'ExL' + upperalldigit(offsetStart) : ''
   }

   if (offsetEnd && offsetEnd.indexOf("px") >= 0) {
      style2 += `right:${offsetEnd};`
      exr = ''
   } else {
      exr = (offsetEnd) ? 'ExR' + upperalldigit(offsetEnd) : ''
   }

   if (lineSpacing && lineSpacing.indexOf("px") >= 0) {
      let lineHeight = (parseInt(lineSpacing.replace('px', '')) + 15) + 'px'
      style2 += `line-height:${lineHeight};`
   }
   text = (!text) ? '' : text
   const wrapper = document.createElement("div");
   // 根據 color 判斷是否要套用次要文字樣式
   let isSecondary = false;
   if (!color || color === '') {
      isSecondary = true;
   } else {
      const c = color.toLowerCase();
      isSecondary = isGrayish(c);
   }
   let Ex2nd = isSecondary ? 'Ex2nd' : '';
   setInnerHTML(wrapper, `<div class="MdTxt flex-element ${fl} ${exabs} ${exmgn} ${alg} ${grv} ${size} ${ExWB} ${ExFntSty} ${ExTxtDec} ${ExWrap} ${Ex2nd} ${ext} ${exb} ${exl} ${exr}" data-flex-type="text" style="${style2}"><p>${text}<!-- content --></p></div>`);
   return wrapper.firstElementChild;
}
export function upper1digit(str) {
   return str.charAt(0).toUpperCase()
}
export function upper2digit(str) {
   return str.charAt(0).toUpperCase() + str.substring(1, 2)
}
export function upperalldigit(str) {
   return str.charAt(0).toUpperCase() + str.slice(1)
}
export function flex2htmlElement(json) {
   let carousel = carousel_struc();
   let result = '';

   // 如果是 Flex message 結構，先取出 contents
   if (json['type'] === 'flex') {
      json = json['contents'];
   }

   // 支援單個 bubble
   if (json['type'] === 'bubble') {
      result = bubble_object(json);
      carousel = carousel.replace('<!-- inner -->', result);
   }
   // 支援 carousel
   else if (json['type'] === 'carousel') {
      json['contents'].forEach((obj, index) => {
         let item = bubble_object(obj);
         item = item.replace('<!-- content -->', '');
         item = item.replace('<!-- inner -->', '');
         carousel = carousel.replace('<!-- inner -->', item + '<!-- inner -->');
      });
   }

   const container = document.createElement("div");
   setInnerHTML(container, carousel);
   return container.firstElementChild;
}
// Removed global assignments and DOMContentLoaded hover binding.
