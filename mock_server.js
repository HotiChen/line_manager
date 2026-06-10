#!/usr/bin/env node
/**
 * Mock Backend Server for LINE Bot Management Platform
 * Runs on port 8787, no Cloudflare auth needed
 * Response formats match the real Cloudflare Worker handlers
 */
const http = require('http');

const MOCK_USER_ID = 'U_demo_user_001';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Bot-Id, Authorization',
  'Content-Type': 'application/json'
};

function json(res, data, status = 200) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(data));
}

const MEMBERS = [
  { memberId: 'Umember001', name: '王小明', lineName: '小明', email: 'ming@example.com', tier: 'gold', phone: '0912-345-678', pictureUrl: 'https://i.pravatar.cc/50?img=1', tags: ['VIP', '常客'], temperature: 'hot', status: 'active', points: 8500, createdAt: '2025-01-10T08:00:00Z' },
  { memberId: 'Umember002', name: '李小華', lineName: '小華', email: 'hua@example.com', tier: 'silver', phone: '0923-456-789', pictureUrl: 'https://i.pravatar.cc/50?img=2', tags: ['新客'], temperature: 'warm', status: 'active', points: 2300, createdAt: '2025-03-15T10:30:00Z' },
  { memberId: 'Umember003', name: '陳大文', lineName: '大文', email: 'dawun@example.com', tier: 'bronze', phone: '0934-567-890', pictureUrl: 'https://i.pravatar.cc/50?img=3', tags: [], temperature: 'cold', status: 'inactive', points: 450, createdAt: '2025-06-20T14:15:00Z' },
  { memberId: 'Umember004', name: '張美麗', lineName: '美麗', email: 'meili@example.com', tier: 'platinum', phone: '0945-678-901', pictureUrl: 'https://i.pravatar.cc/50?img=4', tags: ['VIP', '忠實會員'], temperature: 'hot', status: 'active', points: 25000, createdAt: '2024-11-05T09:00:00Z' },
];

const MOCK_DATA = {
  // Token
  '/token/list': { 'LINE Bot Demo': 'bot_demo_001', 'Test Bot': 'bot_test_002' },

  // Profile — format: { exists, profile }
  '/profile/check': { exists: true, profile: { userId: MOCK_USER_ID, userName: 'Tim Chen (Demo)', userEmail: 'hotichen@gmail.com', lineDisplayName: 'Tim', pictureUrl: 'https://i.pravatar.cc/100', statusMessage: '測試用帳號', activeProject: 'LINE Bot Demo' } },

  // Stats — dashboard expects messageRes.data.stats
  '/stats/messages': { success: true, data: { stats: { push: 125, reply: 340, multicast: 58, broadcast: 10, total: 533, thisMonth: 87 } } },

  // Members — format: { success, data: array }  (worker: member.js:144)
  '/member/list': { success: true, data: MEMBERS },
  '/member/list-full': { success: true, data: MEMBERS },

  // Tags — format: { success, data: array of objects with name }  (worker: tag.js)
  '/tag/list': { success: true, data: [
    { name: 'VIP', total: 2 },
    { name: '常客', total: 1 },
    { name: '新客', total: 1 },
    { name: '忠實會員', total: 1 },
    { name: '促銷對象', total: 0 },
    { name: '高消費', total: 0 },
    { name: '潛力客戶', total: 0 },
  ]},

  // Flex — format: { success, flexs: array }  (worker: flex.js:15)
  '/flex/list': { success: true, flexs: [
    { id: 'flex001', name: '促銷活動橫幅', updatedAt: '2026-03-20T10:00:00Z', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '限時優惠！', weight: 'bold', size: 'xl' }] } } },
    { id: 'flex002', name: '會員卡樣式', updatedAt: '2026-02-14T08:30:00Z', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '您的會員卡', weight: 'bold' }] } } },
    { id: 'flex003', name: '新品介紹', updatedAt: '2026-04-01T12:00:00Z', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '新品上市！', weight: 'bold' }] } } },
  ]},

  // Keywords — format: { success, data: array }  (worker: keyword_reply.js:61)
  '/keyword/list': { success: true, data: [
    { id: 'kw001', keyword: '你好', replyType: 'text', replyContent: '您好！歡迎使用我們的服務，請問有什麼需要幫忙的嗎？', enabled: true },
    { id: 'kw002', keyword: '優惠', replyType: 'text', replyContent: '目前我們有以下優惠活動：\n• 買二送一\n• 首購九折', enabled: true },
    { id: 'kw003', keyword: '營業時間', replyType: 'text', replyContent: '我們的營業時間為週一至週五 09:00-18:00', enabled: false },
  ]},

  // Quick Reply — format: { success, data: array }
  '/quickreply/list': { success: true, data: [
    { id: 'qr001', name: '常見問題選單', items: [{ label: '查詢訂單', text: '我要查詢訂單' }, { label: '聯絡客服', text: '我要聯絡客服' }, { label: '查看優惠', text: '查看最新優惠' }] },
    { id: 'qr002', name: '評分選單', items: [{ label: '⭐⭐⭐⭐⭐ 非常滿意', text: '5星' }, { label: '⭐⭐⭐⭐ 滿意', text: '4星' }] },
  ]},

  // Imagemap — format: { success, imagemaps: array }  (worker: imagemap.js:18)
  '/imagemap/list': { success: true, imagemaps: [
    { id: 'im001', name: '首頁橫幅', baseUrl: 'https://picsum.photos/1040/585', altText: '首頁橫幅', baseSize: { width: 1040, height: 585 }, updatedAt: '2026-02-10T11:00:00Z' },
    { id: 'im002', name: '產品介紹圖', baseUrl: 'https://picsum.photos/1040/585?random=2', altText: '產品介紹', baseSize: { width: 1040, height: 585 }, updatedAt: '2026-03-05T09:30:00Z' },
  ]},

  // Team — format: { members: array }  (worker: team.js:16-18)
  '/team/list': { members: [
    { userId: 'U_member_a', name: '管理員A', email: 'admin@example.com', role: 'admin', avatar: 'https://i.pravatar.cc/50?img=10' },
    { userId: 'U_member_b', name: '編輯員B', email: 'editor@example.com', role: 'editor', avatar: 'https://i.pravatar.cc/50?img=11' },
  ]},

  // Tier — format: { success, config: array }  (worker: tier.js:22)
  '/tier/config': { success: true, config: [
    { id: 'bronze', name: 'Bronze', icon: '🥉', minPoints: 0, maxPoints: 999, color: '#CD7F32', benefits: ['基本會員優惠'] },
    { id: 'silver', name: 'Silver', icon: '🥈', minPoints: 1000, maxPoints: 4999, color: '#C0C0C0', benefits: ['9折優惠', '優先服務'] },
    { id: 'gold', name: 'Gold', icon: '🥇', minPoints: 5000, maxPoints: 19999, color: '#FFD700', benefits: ['85折優惠', '專屬客服', '生日禮'] },
    { id: 'platinum', name: 'Platinum', icon: '💎', minPoints: 20000, maxPoints: null, color: '#E5E4E2', benefits: ['8折優惠', '專屬顧問', '免費配送', '生日禮'] },
  ]},
  '/tier/stats': { success: true, stats: { bronze: 42, silver: 28, gold: 15, platinum: 4 } },

  // Flow — format: { success, flows: array }  (worker: flow.js:111-113)
  '/flow/list': { success: true, flows: [
    { id: 'flow001', name: '新會員歡迎流程', nodeCount: 5, edgeCount: 4, updatedAt: '2026-04-01T10:00:00Z' },
    { id: 'flow002', name: '購物車放棄追蹤', nodeCount: 8, edgeCount: 7, updatedAt: '2026-03-28T15:30:00Z' },
  ]},

  // Richmenu — format: { richmenus: array }  (worker: richmenu.js:62, NO success wrapper)
  '/richmenu/list': { richmenus: [
    { richMenuId: 'rm001', name: '主選單', size: { width: 2500, height: 843 }, selected: true, areas: [] },
    { richMenuId: 'rm002', name: '次選單', size: { width: 2500, height: 843 }, selected: false, areas: [] },
  ]},

  // Image messages (圖文訊息)
  '/image_msg/list': { success: true, data: [
    { id: 'img001', name: '春季特賣', imageUrl: 'https://picsum.photos/1040/585?random=3', updatedAt: '2026-03-01T09:00:00Z' },
    { id: 'img002', name: '會員招募', imageUrl: 'https://picsum.photos/1040/585?random=4', updatedAt: '2026-04-05T14:00:00Z' },
  ]},
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:8787');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const path = url.pathname;
    console.log(`[MOCK] ${req.method} ${path}`);

    // Token
    if (path === '/token/register' || path === '/token/set') return json(res, { success: true, message: 'OK' });
    if (path === '/token/list') return json(res, MOCK_DATA['/token/list']);

    // Profile
    if (path === '/profile/check' || path === '/profile/get') return json(res, MOCK_DATA['/profile/check']);
    if (path.startsWith('/profile')) return json(res, { success: true, message: 'OK' });

    // Stats
    if (path === '/stats' || path === '/stats/messages') return json(res, MOCK_DATA['/stats/messages']);

    // Members
    if (path === '/member/list-full') return json(res, MOCK_DATA['/member/list-full']);
    if (path === '/member/list' || path === '/member/all') return json(res, MOCK_DATA['/member/list']);
    if (path === '/member/register' || path === '/member/save') return json(res, { success: true, message: '操作成功' });
    if (path === '/member/delete') return json(res, { success: true, message: '已刪除' });
    if (path.startsWith('/member')) return json(res, { success: true, data: MOCK_DATA['/member/list'].data[0] });

    // Tags
    if (path === '/tag/list') return json(res, MOCK_DATA['/tag/list']);
    if (path === '/tag/save' || path === '/tag/delete') return json(res, { success: true });
    if (path.startsWith('/tag')) return json(res, MOCK_DATA['/tag/list']);

    // Flex
    if (path === '/flex/list') return json(res, MOCK_DATA['/flex/list']);
    if (path.startsWith('/flex')) return json(res, { success: true, message: '操作成功' });

    // Keywords
    if (path === '/keyword/list') return json(res, MOCK_DATA['/keyword/list']);
    if (path === '/keyword/stats') return json(res, { success: true, data: { stats: { total: 5 } } });
    if (path.startsWith('/keyword')) return json(res, { success: true, message: '操作成功' });

    // Quick Replies
    if (path === '/quickreply/list' || path === '/quick_reply/list') return json(res, MOCK_DATA['/quickreply/list']);
    if (path.startsWith('/quickreply') || path.startsWith('/quick_reply')) return json(res, { success: true, message: '操作成功' });

    // Imagemap
    if (path === '/imagemap/list') return json(res, MOCK_DATA['/imagemap/list']);
    if (path.startsWith('/imagemap')) return json(res, { success: true, message: '操作成功' });

    // Image messages
    if (path === '/image_msg/list') return json(res, MOCK_DATA['/image_msg/list']);
    if (path.startsWith('/image_msg')) return json(res, { success: true, message: '操作成功' });

    // Team
    if (path === '/team/list' || path.startsWith('/team')) return json(res, MOCK_DATA['/team/list']);

    // Tier
    if (path === '/tier/config') return json(res, MOCK_DATA['/tier/config']);
    if (path === '/tier/stats') return json(res, MOCK_DATA['/tier/stats']);
    if (path.startsWith('/tier')) return json(res, { success: true });

    // Flow
    if (path === '/flow/list') return json(res, MOCK_DATA['/flow/list']);
    if (path.startsWith('/flow')) return json(res, { success: true, flowId: 'flow_mock_001', updatedAt: new Date().toISOString() });

    // Richmenu
    if (path === '/richmenu/list') return json(res, MOCK_DATA['/richmenu/list']);
    if (path === '/richmenu/default') return json(res, { richMenuId: 'rm001' });
    if (path === '/richmenu/sync') return json(res, { success: true, errors: [] });
    if (path.startsWith('/richmenu')) return json(res, { success: true, message: '操作成功' });

    // Send message / push
    if (path.startsWith('/api/send-message') || path.startsWith('/push') || path.startsWith('/api')) return json(res, { success: true, result: { sentCount: 1 } });

    // User bots
    if (path.startsWith('/user/bot')) return json(res, { success: true, bots: [] });

    // Debug
    if (path === '/debug-ping') return json(res, { success: true, version: 'MOCK_V2.0' });

    // Welcome message / bot config
    if (path.startsWith('/bot') || path.startsWith('/welcome')) return json(res, { success: true });

    json(res, { error: 'Not Found', path }, 404);
  });
}).listen(8787, () => console.log('✅ Mock backend running on http://localhost:8787'));
