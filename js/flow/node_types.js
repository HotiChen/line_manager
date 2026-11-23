// js/flow/node_types.js
// 節點類型、外觀設定與預設資料。純資料，不碰 DOM（node:test 可直接 import）。

/**
 * 節點類型定義
 */
export const NodeTypes = {
    // 觸發器
    RICHMENU: 'richmenu',
    KEYWORD: 'keyword',
    WEBHOOK: 'webhook',

    // 訊息節點
    MESSAGE_TEXT: 'message_text',
    MESSAGE_FLEX: 'message_flex',
    MESSAGE_IMAGEMAP: 'message_imagemap',
    MESSAGE_IMAGE: 'message_image',
    MESSAGE_SEQUENCE: 'message_sequence',  // 訊息序列

    // 動作節點
    ACTION_DELAY: 'action_delay',
    ACTION_CONDITION: 'action_condition',
    ACTION_API: 'action_api',
    ACTION_TAG: 'action_tag',
    URL: 'url',
    POSTBACK: 'postback',

    // 結束節點
    END: 'end'
};

/**
 * 節點類型配置
 */
export const NodeTypeConfig = {
    [NodeTypes.RICHMENU]: {
        label: 'Richmenu',
        icon: 'bi-menu-button',
        color: '#9b59b6',
        category: 'trigger',
        description: 'LINE Richmenu 選單',
        multipleOutputs: true  // 支援多輸出（每個按鈕一個）
    },
    [NodeTypes.KEYWORD]: {
        label: '關鍵字觸發',
        icon: 'bi-key',
        color: '#3498db',
        category: 'trigger',
        description: '當用戶輸入特定關鍵字時觸發'
    },
    [NodeTypes.MESSAGE_TEXT]: {
        label: '文字訊息',
        icon: 'bi-chat-text',
        color: '#3498db',
        category: 'message',
        description: '發送文字訊息給用戶'
    },
    [NodeTypes.MESSAGE_IMAGE]: {
        label: '圖片訊息',
        icon: 'bi-image-fill',
        color: '#3498db',
        category: 'message',
        description: '發送圖片給用戶'
    },
    [NodeTypes.MESSAGE_SEQUENCE]: {
        label: '訊息序列',
        icon: 'bi-chat-left-dots',
        color: '#16a085',
        category: 'message',
        description: '發送多個訊息（最多5個）'
    },
    [NodeTypes.MESSAGE_FLEX]: {
        label: 'Flex Message',
        icon: 'bi-phone',
        color: '#3498db',
        category: 'message',
        description: '發送 Flex 圖文訊息',
        multipleOutputs: true  // Flex 可能有多個按鈕
    },
    [NodeTypes.MESSAGE_IMAGEMAP]: {
        label: 'Imagemap',
        icon: 'bi-image',
        color: '#3498db',
        category: 'message',
        description: '發送 Imagemap 互動圖片'
    },
    [NodeTypes.ACTION_DELAY]: {
        label: '延遲',
        icon: 'bi-clock',
        color: '#f39c12',
        category: 'action',
        description: '等待指定時間後繼續'
    },
    [NodeTypes.ACTION_CONDITION]: {
        label: '條件判斷',
        icon: 'bi-code-square',
        color: '#f39c12',
        category: 'action',
        description: '根據條件分支流程',
        multipleOutputs: true  // 條件有多個分支
    },
    [NodeTypes.ACTION_API]: {
        label: '呼叫 API',
        icon: 'bi-cloud-arrow-down',
        color: '#f39c12',
        category: 'action',
        description: '呼叫外部網址，結果可用 (@api.欄位) 放進後面的訊息'
    },
    [NodeTypes.ACTION_TAG]: {
        label: '標籤操作',
        icon: 'bi-tag',
        color: '#f39c12',
        category: 'action',
        description: '為用戶新增或移除標籤'
    },
    [NodeTypes.URL]: {
        label: 'URL 連結',
        icon: 'bi-link-45deg',
        color: '#16a085',
        category: 'action',
        description: '開啟網址連結'
    },
    [NodeTypes.POSTBACK]: {
        label: 'Postback',
        icon: 'bi-arrow-return-left',
        color: '#d35400',
        category: 'action',
        description: 'Postback 回傳資料'
    },
    [NodeTypes.END]: {
        label: '結束',
        icon: 'bi-x-circle',
        color: '#e74c3c',
        category: 'end',
        description: '流程結束點'
    }
};

/**
 * 新節點的預設 data（每次呼叫都回傳新物件，避免共用參照）
 */
export function getDefaultNodeData(type) {
    const defaults = {
        [NodeTypes.RICHMENU]: {
            richmenuId: null,
            name: '選擇 Richmenu',
            buttons: []
        },
        [NodeTypes.KEYWORD]: {
            keyword: '',
            matchType: 'exact'  // exact, contains, regex
        },
        [NodeTypes.MESSAGE_TEXT]: {
            text: '請輸入訊息內容'
        },
        [NodeTypes.MESSAGE_SEQUENCE]: {
            name: '訊息序列',
            messages: [],
            delay: 0  // 訊息間延遲（毫秒）
        },
        [NodeTypes.MESSAGE_IMAGE]: {
            url: '',
            previewUrl: ''
        },
        [NodeTypes.ACTION_API]: {
            url: '',
            method: 'GET',
            headers: '{}',
            body: '{}'
        },
        [NodeTypes.MESSAGE_FLEX]: {
            flexId: null,
            title: '選擇 Flex Message'
        },
        [NodeTypes.MESSAGE_IMAGEMAP]: {
            imagemapId: null,
            title: '選擇 Imagemap',
            isExpanded: false  // 防止重複展開
        },
        [NodeTypes.ACTION_DELAY]: {
            seconds: 1
        },
        [NodeTypes.ACTION_CONDITION]: {
            conditions: [
                { field: 'text', operator: 'equals', value: '' }
            ],
            branches: ['true', 'false']
        },
        [NodeTypes.ACTION_TAG]: {
            operation: 'add',  // add, remove
            tags: []
        },
        [NodeTypes.URL]: {
            url: '',
            label: 'URL 連結'
        },
        [NodeTypes.POSTBACK]: {
            data: '',
            label: 'Postback',
            displayText: ''
        },
        [NodeTypes.END]: {
            message: '流程結束'
        }
    };

    return defaults[type] || { label: '未知節點' };
}
