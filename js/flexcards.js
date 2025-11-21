import {
    image_object,
    text_object,
    box_object,
    button_object,
    span_object,
    filler_object,
    icon_object,
    separator_object,
    bubble_object,
    flex2html,
    upper2digit
} from '../js/flex2html.js';

export function createNameCardComponent(components, clickable, editable, swiper){
  var returnComp = document.createElement("div");
  returnComp.style.borderRadius = "5px";

  var keyList = Object.keys(components);
  for(var vkey in keyList){
    switch (keyList[vkey]) {
      case "type":
        switch (components.type)
        {
          case "bubble":
            {
              var bubble = document.createElement('div');
              var size = components.size;
              size = (!size || size === '') ? 'medium' : size;
              var direction = components.direction;
              direction = (!direction || direction == '') ? 'ltr' : direction
              size = upper2digit(size);

              bubble.className= "lyItem Ly"+size;

              var subDiv = document.createElement('div');
              subDiv.className = "T1 fx"+direction.toUpperCase();
              subDiv.dir=direction;
              bubble.appendChild(subDiv);

              var styles ="";
              if(components.styles)
                styles = components.styles;

              if(components.hero){
                var vHero = document.createElement('div')
                vHero.className = "t1Hero";

                if(styles.hero)
                  vHero.style.backgroundColor = styles.hero.backgroundColor;
                subDiv.appendChild(vHero);
                vHero.appendChild(createNameCardComponent(components.hero, clickable, editable, swiper));
              }
              if(components.header)
              {
                var vHeader = document.createElement('div')
                vHeader.className = "t1Header";
                if(styles.header)
                  vHeader.style.backgroundColor = styles.header.backgroundColor;
                subDiv.appendChild(vHeader);
                vHeader.appendChild(createNameCardComponent(components.header, clickable, editable, swiper));
              }
              if(components.body){
                var vBody = document.createElement('div')
                vBody.className = "t1Body";
                if(styles.body)
                  vBody.style.backgroundColor = styles.body.backgroundColor;
                subDiv.appendChild(vBody);
                vBody.appendChild(createNameCardComponent(components.body, clickable, editable, swiper));
              }
              if(components.footer){
                var vFooter = document.createElement('div')
                vFooter.className = "t1Footer";
                if(styles.footer)
                  vFooter.style.backgroundColor = styles.footer.backgroundColor;
                subDiv.appendChild(vFooter);
                vFooter.appendChild(createNameCardComponent(components.footer, clickable, editable, swiper));
              }
              return bubble;
            }
            break;
          case "image":
            {
              var vImgObj = image_object(components, editable)
              if(editable == true) {
                vImgObj.addEventListener("click",  function(event) {
                  event.preventDefault();
                  event.stopPropagation();
                  window.openFlexElementModal(vImgObj);
                });
              } else if(components.action && clickable == true) {
                // ... (original clickable logic)
              }
              return vImgObj;
            }
            break;

          case "box":
            {
              var vBoxObj = box_object(components, editable);
              var fragment = document.createDocumentFragment();
              for(var vContent of components.contents){
                fragment.appendChild(createNameCardComponent(vContent, clickable, editable, swiper));
              }
              vBoxObj.appendChild(fragment);
              return vBoxObj;
            }
            break;

          case "text":
            {
              var span = text_object(components);
              if(editable == true) {
                span.addEventListener("click",  function(event) {
                  event.preventDefault();
                  event.stopPropagation();
                  window.openFlexElementModal(span);
                });
              }
              return span;
            }
            break;

          case "button":
            {
              var vButtonObj = button_object(components);
              var actions = components.action || {};

              console.log(clickable +" :clickable < ------> editable: "+ editable)
              if(editable == true) {
                console.log("hihihi")
                vButtonObj.addEventListener("click", function(event) {
                  event.preventDefault();
                  event.stopPropagation();
                  window.openFlexElementModal(vButtonObj);
                });
              } else if(clickable == true){
                console.log("i can't be here!")
                vButtonObj.onclick = function(){
                  var targetId;
                  if(actions.uri.indexOf("1655037190-wll0NQ5Y")>0)
                  {
                    if(actions.uri.indexOf('?')!=-1)
                    {
                      var ary = actions.uri.split('?')[1].split('&');
                      for(i=0;i<ary.length;i++)
                      {
                        if(ary[i].split('=')[0] == 'id')
                        {
                          targetId = ary[i].split('=')[1];
                          var param = {id:targetId};
                          getRecievedCard(param)
                        }
                      }
                    }
                  }
                  else {
                    location.href = actions.uri;
                  }
                };
              }
              return vButtonObj;
            }
            break;
        }
        break;

      default:
    }
  }
  return returnComp;
}
