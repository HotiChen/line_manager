export const systemTemplates = {
    hello: {
      type: "bubble",
      hero: {
        type: "image",
        url: "https://live.staticflickr.com/65535/49638824982_19b955697d_c.jpg",
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "none",
        contents: [
          {
            type: "box",
            layout: "baseline",
            spacing: "none",
            contents: [
              {
                type: "text",
                text: "熱茶",
                size: "xl",
                gravity: "center",
                weight: "bold",
                wrap: true
              },
              {
                type: "text",
                text: "熱茶攝影  品禔設計室",
                flex: 2
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "box",
                layout: "baseline",
                spacing: "none",
                contents: [
                  {
                    type: "text",
                    text: "項目",
                    flex: 1,
                    size: "lg",
                    color: "#AAAAAA"
                  },
                  {
                    type: "text",
                    text: "婚禮、婚紗、孕、親子、活動、形象拍攝、商品",
                    flex: 4,
                    size: "sm",
                    color: "#666666",
                    wrap: true
                  }
                ]
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "none",
        contents: [
          {
            type: "button",
            style: "link",
            height: "sm",
            action: {
              type: "uri",
              label: "熱茶官方網站",
              uri: "https://imhoti.tw"
            }
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "none",
            contents: [
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "FB 粉絲團",
                  uri: "https://www.facebook.com/HotTeaPhoto/"
                }
              },
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "Instagram",
                  uri: "https://www.instagram.com/hoti_photography/"
                }
              }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "分享熱茶",
                  uri: "https://liff.line.me/1655037190-wll0NQ5Y?id=Uc2a2f40672566599e9245e3d0d45281b"
                }
              },
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "加入熱茶",
                  uri: "https://line.me/ti/p/XUa2jilMmp"
                }
              }
            ]
          }
        ],
        flex: 0
      }
    },
  
    product: {
      type: "flex",
      altText: "商品卡片",
      contents: {
        type: "bubble",
        hero: {
          type: "image",
          url: "https://example.com/product.jpg",
          size: "full",
          aspectRatio: "20:13",
          aspectMode: "cover"
        },
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            { type: "text", text: "商品名稱", weight: "bold", size: "xl" },
            { type: "text", text: "商品簡介說明", size: "sm", color: "#999999" }
          ]
        }
      }
    },
  
    sampleTemplate: {
      type: "carousel",
      contents: [
        {
          type: "bubble",
      hero: {
        type: "image",
        url: "https://live.staticflickr.com/65535/49638824982_19b955697d_c.jpg",
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "none",
        contents: [
          {
            type: "box",
            layout: "baseline",
            spacing: "none",
            contents: [
              {
                type: "text",
                text: "熱茶",
                size: "xl",
                gravity: "center",
                weight: "bold",
                wrap: true
              },
              {
                type: "text",
                text: "熱茶攝影  品禔設計室",
                flex: 2
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "box",
                layout: "baseline",
                spacing: "none",
                contents: [
                  {
                    type: "text",
                    text: "項目",
                    flex: 1,
                    size: "lg",
                    color: "#AAAAAA"
                  },
                  {
                    type: "text",
                    text: "婚禮、婚紗、孕、親子、活動、形象拍攝、商品",
                    flex: 4,
                    size: "sm",
                    color: "#666666",
                    wrap: true
                  }
                ]
              }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "none",
        contents: [
          {
            type: "button",
            style: "link",
            height: "sm",
            action: {
              type: "uri",
              label: "熱茶官方網站",
              uri: "https://imhoti.tw"
            }
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "none",
            contents: [
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "FB 粉絲團",
                  uri: "https://www.facebook.com/HotTeaPhoto/"
                }
              },
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "Instagram",
                  uri: "https://www.instagram.com/hoti_photography/"
                }
              }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "分享熱茶",
                  uri: "https://liff.line.me/1655037190-wll0NQ5Y?id=Uc2a2f40672566599e9245e3d0d45281b"
                }
              },
              {
                type: "button",
                style: "link",
                action: {
                  type: "uri",
                  label: "加入熱茶",
                  uri: "https://line.me/ti/p/XUa2jilMmp"
                }
              }
            ]
          }
        ],
        flex: 0
      }
        },
        {
          "type": "bubble",
          "hero": {
            "type": "image",
            "url": "https://drive.google.com/uc?id=1vCnZTmM6H5aFYcjEgtKNhLgkaPIEmCsq",
            "size": "full",
            "aspectRatio": "20:13",
            "aspectMode": "cover"
          },
          "body": {
            "type": "box",
            "layout": "vertical",
            "spacing": "none",
            "contents": [
              {
                "type": "box",
                "layout": "horizontal",
                "contents": [
                  {
                    "type": "text",
                    "text": "京尚禾",
                    "size": "xl",
                    "gravity": "top",
                    "weight": "bold",
                    "wrap": true,
                    "flex": 2
                  },
                  {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [
                      {
                        "type": "box",
                        "layout": "horizontal",
                        "contents": [
                          {
                            "type": "text",
                            "text": "0227622093",
                            "action": {
                              "type": "uri",
                              "label": "電話",
                              "uri": "tel:0227622093"
                            },
                            "flex": 4,
                            "size": "sm",
                            "align": "end"
                          },
                          {
                            "type": "image",
                            "url": "https://live.staticflickr.com/65535/51081292808_46f2ca82cc_t.jpg",
                            "size": "20px",
                            "action": {
                              "type": "uri",
                              "label": "電話",
                              "uri": "tel:0226722093"
                            }
                          }
                        ]
                      },
                      {
                        "type": "box",
                        "layout": "horizontal",
                        "contents": [
                          {
                            "type": "text",
                            "text": "新北市三峽區國際一街29之1號4樓",
                            "size": "sm",
                            "flex": 5,
                            "wrap": true,
                            "align": "end"
                          },
                          {
                            "type": "image",
                            "url": "https://live.staticflickr.com/65535/51081972481_cd81b63c40_t.jpg",
                            "action": {
                              "type": "uri",
                              "label": "237新北市三峽區國際一街29號四樓",
                              "uri": "https://goo.gl/maps/jrS6NEMi377XpZH49"
                            },
                            "size": "20px",
                            "gravity": "center"
                          }
                        ]
                      }
                    ],
                    "flex": 5,
                    "spacing": "none",
                    "margin": "none"
                  }
                ],
                "spacing": "none"
              },
              {
                "type": "box",
                "layout": "vertical",
                "contents": [
                  {
                    "type": "box",
                    "layout": "baseline",
                    "spacing": "none",
                    "contents": [
                      {
                        "type": "text",
                        "text": "服務項目",
                        "flex": 2,
                        "size": "lg",
                        "color": "#AAAAAA"
                      },
                      {
                        "type": "text",
                        "text": "請輸入",
                        "flex": 4,
                        "size": "sm",
                        "color": "#666666",
                        "wrap": true
                      }
                    ]
                  }
                ]
              }
            ]
          },
          "footer": {
            "type": "box",
            "layout": "vertical",
            "spacing": "none",
            "contents": [
              {
                "type": "button",
                "style": "link",
                "height": "sm",
                "action": {
                  "type": "uri",
                  "label": "京尚禾粉專",
                  "uri": "http://pili.app/pg/VNyetWYd"
                }
              },
              {
                "type": "box",
                "layout": "horizontal",
                "contents": [
                  {
                    "type": "button",
                    "style": "link",
                    "action": {
                      "type": "uri",
                      "label": "心靈宇宙",
                      "uri": "https://reurl.cc/NZxADe"
                    }
                  },
                  {
                    "type": "button",
                    "style": "link",
                    "action": {
                      "type": "uri",
                      "label": "影音短片",
                      "uri": "https://reurl.cc/2oQZN4"
                    }
                  }
                ],
                "spacing": "none"
              },
              {
                "type": "box",
                "layout": "horizontal",
                "contents": [
                  {
                    "type": "button",
                    "style": "link",
                    "action": {
                      "type": "uri",
                      "label": "分享京尚禾",
                      "uri": "https://liff.line.me/1655037190-wll0NQ5Y?id=U0c2e1d3332cbf80d9cab79f2d052fc8a"
                    }
                  },
                  {
                    "type": "button",
                    "action": {
                      "type": "uri",
                      "label": "諮詢服務",
                      "uri": "https://line.me/ti/p/~jsh26886"
                    }
                  }
                ]
              }
            ],
            "flex": 0
          }
        },{
          type: "bubble",
          hero: {
            type: "image",
            url: "https://via.placeholder.com/600x400",
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
          },
          body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              { type: "text", text: "超人氣暖毛毯", weight: "bold", size: "lg" },
              { type: "text", text: "冬季限定色，限量發售", size: "sm", color: "#666666" },
              { type: "text", text: "$980", size: "xl", weight: "bold", color: "#e53935" }
            ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                style: "primary",
                action: {
                  type: "uri",
                  label: "立即購買",
                  uri: "https://yourshop.com"
                }
              }
            ]
          }
        }
      ]
    }
  };