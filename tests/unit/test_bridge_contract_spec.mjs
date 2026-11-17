/**
 * Unit Tests — docs/integration/bridge-v1.yaml 本身（LM-1D 契約測試之一：規格自洽、與程式常數一致）
 *
 * 另一半是 test_bridge_contract_conformance.mjs（對真實 Worker 發請求，檢查回應是否符合規格）。
 * 這裡不打任何 D1／LINE：只比對規格檔與程式碼裡的常數（錯誤碼、scope、格式、長度上限）。
 *
 * 失敗時的意思：規格與實作其中一邊漂移了。以已出貨並實機驗證過的實作為準就改規格；若實作是 bug 則改程式並補回歸測試。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    loadSpec, collectRefs, resolvePointer, deref, operations, validateAgainst, CONFORMANCE, UNEXERCISED,
} from '../helpers/bridge_contract.mjs';
import { ERROR_DEFAULTS, ERROR_CODES } from '../../worker_src/bridge/errors.js';
import { LINK_SCOPES, FORBIDDEN_LINK_SCOPES } from '../../worker_src/bridge/scopes.js';
import { CONTACT_REF_RE } from '../../worker_src/bridge/contacts.js';
import { generateBindCode } from '../../worker_src/bridge/binding.js';
import { validateNotification } from '../../worker_src/bridge/notify.js';
import { handleBridge } from '../../worker_src/bridge/index.js';

const spec = loadSpec();
const STATUSES = ['implemented', 'partial', 'planned'];
const ops = operations(spec);
const schemas = spec.components.schemas;

const sorted = (a) => [...a].sort();

describe('規格檔結構', () => {
    it('YAML 解析成 OpenAPI 3.0 文件，且有 paths 與 components', () => {
        assert.match(spec.openapi, /^3\.0\./);
        assert.ok(spec.paths && Object.keys(spec.paths).length > 0);
        assert.ok(spec.components && spec.components.schemas && spec.components.responses);
        assert.ok(ops.length >= 12, `操作數 ${ops.length}`);
    });

    it('所有 $ref 都能解開，且只指向本檔內', () => {
        const refs = collectRefs(spec);
        assert.ok(refs.length > 20);
        for (const ref of refs) {
            assert.ok(ref.startsWith('#/components/'), `非本檔 components 的 $ref：${ref}`);
            resolvePointer(spec, ref);
        }
    });

    it('每個路徑都在 /bridge/v1 之下；路徑上的每個 {參數} 都有宣告為 path parameter', () => {
        for (const [path, item] of Object.entries(spec.paths)) {
            assert.ok(path.startsWith('/bridge/v1/'), path);
            for (const { method, op } of ops.filter((o) => o.path === path)) {
                const declared = [...(item.parameters || []), ...(op.parameters || [])].map((p) => deref(spec, p)).filter((p) => p.in === 'path').map((p) => p.name);
                for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
                    assert.ok(declared.includes(name), `${method} ${path} 缺少 path parameter ${name}`);
                }
            }
        }
    });

    it('每個操作都有 x-status（implemented / partial / planned），且與 x-status-legend 的鍵一致', () => {
        assert.deepEqual(sorted(Object.keys(spec.info['x-status-legend'])), sorted(STATUSES));
        for (const { key, op } of ops) {
            assert.ok(STATUSES.includes(op['x-status']), `${key} 的 x-status 是 ${JSON.stringify(op['x-status'])}`);
        }
    });

    it('每個操作都有 x-scope（且是 Scope enum 內的值），或明確標示公開（security: []）／產品密鑰認證', () => {
        const scopes = schemas.Scope.enum;
        for (const { key, op } of ops) {
            if (op['x-scope'] !== undefined) {
                assert.ok(scopes.includes(op['x-scope']), `${key} 的 x-scope ${op['x-scope']} 不在 Scope enum`);
                continue;
            }
            const security = op.security;
            const isPublic = Array.isArray(security) && security.length === 0;
            const isProductAuth = Array.isArray(security) && security.length > 0 && security.every((s) => Object.keys(s).every((k) => k === 'productSecret'));
            assert.ok(isPublic || isProductAuth, `${key} 沒有 x-scope，也沒有明確標示為公開或產品密鑰認證`);
        }
    });

    it('每個操作的每個狀態碼都是三位數字，且有 description（直接或經 $ref）', () => {
        for (const { key, op } of ops) {
            assert.ok(Object.keys(op.responses).length > 0, key);
            for (const [status, r] of Object.entries(op.responses)) {
                assert.match(status, /^[1-5]\d\d$/, `${key} ${status}`);
                assert.ok(typeof deref(spec, r).description === 'string', `${key} ${status} 缺 description`);
            }
        }
    });

    it('規格檔內的範例值符合各自的 schema（ContactRef、Scope、MessageResult 等）', () => {
        validateAgainst(spec, schemas.ContactRef, schemas.ContactRef.example, 'ContactRef.example');
        assert.ok(schemas.Scope.enum.length > 0);
        validateAgainst(spec, { $ref: '#/components/schemas/Error' }, { error: { code: 'INTERNAL', message: 'x', retryable: true } }, 'Error');
        assert.throws(() => validateAgainst(spec, { $ref: '#/components/schemas/Error' }, { error: { code: 'NOT_A_CODE', message: 'x', retryable: true } }), /不符合規格/);
        assert.throws(() => validateAgainst(spec, { $ref: '#/components/schemas/MessageResult' }, { message_id: 'm', status: 'sent', sent_at: 'yesterday' }), /不符合規格/);
        validateAgainst(spec, { $ref: '#/components/schemas/MessageResult' }, { message_id: 'm', status: 'sent', sent_at: '2026-01-02T03:04:05.000Z' });
    });
});

describe('規格與程式常數一致', () => {
    it('Error.code enum 與 errors.js 的 ERROR_DEFAULTS 完全相同（不多不少）', () => {
        const specCodes = schemas.Error.properties.error.properties.code.enum;
        assert.equal(new Set(specCodes).size, specCodes.length, 'enum 有重複');
        assert.deepEqual(sorted(specCodes), sorted(Object.keys(ERROR_DEFAULTS)));
        assert.deepEqual(sorted(specCodes), sorted(ERROR_CODES));
    });

    it('Scope enum = scopes.js 的 LINK_SCOPES 加上 raw:push（raw:push 屬於信任金鑰，不在連結流程內）', () => {
        assert.deepEqual(sorted(schemas.Scope.enum), sorted([...LINK_SCOPES, 'raw:push']));
        assert.ok(FORBIDDEN_LINK_SCOPES.includes('raw:push'));
        assert.ok(!LINK_SCOPES.includes('raw:push'));
        // token 與 Link 的 scopes 都引用同一個 Scope（連結流程實際只會出現 LINK_SCOPES，由 conformance 驗證）
        assert.equal(schemas.Link.properties.scopes.items.$ref, '#/components/schemas/Scope');
    });

    it('ContactRef pattern 與 contacts.js 的 CONTACT_REF_RE 相同，且邊界行為一致', () => {
        assert.equal(schemas.ContactRef.pattern, CONTACT_REF_RE.source);
        const specRe = new RegExp(schemas.ContactRef.pattern);
        for (const sample of ['abcdefgh', 'abcdefg', 'a'.repeat(64), 'a'.repeat(65), 'ab-cd_EF12', 'ab cd efgh', 'ab.cd.efgh', 'abcdefgh\n', '中文中文中文中文', '']) {
            assert.equal(specRe.test(sample), CONTACT_REF_RE.test(sample), JSON.stringify(sample));
        }
        assert.equal(schemas.Notification.properties.external_contact_ref.$ref, '#/components/schemas/ContactRef');
    });

    it('綁定碼範例與實作產生的格式相符（LM- + 8 碼 Crockford base32）', () => {
        const example = deref(spec, spec.paths['/bridge/v1/contacts/bind-tokens'].post.responses['201']).content['application/json'].schema.properties.bind_code.example;
        const re = /^LM-[0-9A-HJKMNP-TV-Z]{8}$/;
        assert.match(example, re);
        for (let i = 0; i < 20; i++) assert.match(generateBindCode(), re);
    });

    describe('Notification 與 notify.js 的驗證一致（以行為斷言，上限常數不輸出）', () => {
        const N = schemas.Notification;
        const valid = { external_contact_ref: 'customer-0001', event_type: 'order.shipped', title: 'T', body: 'B' };
        const accepts = (over) => !('error' in validateNotification({ ...valid, ...over }));

        it('欄位集合：required、properties、additionalProperties:false（含 action）', () => {
            assert.equal(N.additionalProperties, false);
            assert.deepEqual(sorted(N.required), sorted(['external_contact_ref', 'event_type', 'title', 'body']));
            const props = Object.keys(N.properties);
            assert.deepEqual(sorted(props), sorted(['external_contact_ref', 'event_type', 'title', 'body', 'action']));
            // 實作接受規格列出的每個欄位（含 action），拒絕未知欄位
            assert.ok(accepts({ action: { label: 'go', url: 'https://x.example.com/' } }));
            assert.ok(!accepts({ extra: 1 }));
            for (const req of N.required) {
                const { [req]: _omit, ...rest } = valid;
                assert.ok('error' in validateNotification(rest), `缺 ${req} 應被拒絕`);
            }
            const A = N.properties.action;
            assert.equal(A.additionalProperties, false);
            assert.deepEqual(sorted(A.required), ['label', 'url']);
            assert.ok(!accepts({ action: { label: 'go', url: 'https://x.example.com/', extra: 1 } }));
            assert.ok(!accepts({ action: { label: 'go' } }));
            assert.ok(!accepts({ action: { url: 'https://x.example.com/' } }));
        });

        it('title 上限（規格 maxLength）= 實作上限；以 code point 計', () => {
            const max = N.properties.title.maxLength;
            assert.equal(max, 40);
            assert.ok(accepts({ title: 'a'.repeat(max) }));
            assert.ok(!accepts({ title: 'a'.repeat(max + 1) }));
            assert.ok(accepts({ title: '😀'.repeat(max) }), 'emoji 算 1 個字元');
        });

        it('body 上限（規格 maxLength）= 實作上限', () => {
            const max = N.properties.body.maxLength;
            assert.equal(max, 300);
            assert.ok(accepts({ body: 'a'.repeat(max) }));
            assert.ok(!accepts({ body: 'a'.repeat(max + 1) }));
        });

        it('action.label 上限（規格 maxLength）= 實作上限', () => {
            const max = N.properties.action.properties.label.maxLength;
            assert.equal(max, 20);
            const url = 'https://x.example.com/';
            assert.ok(accepts({ action: { label: 'a'.repeat(max), url } }));
            assert.ok(!accepts({ action: { label: 'a'.repeat(max + 1), url } }));
        });

        it('event_type pattern 與實作對同一批樣本的接受結果一致', () => {
            const re = new RegExp(N.properties.event_type.pattern);
            assert.equal(N.properties.event_type.pattern, '^[a-z][a-z0-9_.]{0,63}$');
            const samples = ['a', 'order.shipped', 'a_b.c9', `a${'b'.repeat(63)}`, `a${'b'.repeat(64)}`, 'A', '1abc', 'a-b', 'a b', '', '.abc', 'order\n', 'é'];
            for (const s of samples) {
                assert.equal(accepts({ event_type: s }), re.test(s), `event_type ${JSON.stringify(s)}`);
            }
        });

        it('Idempotency-Key 參數 maxLength 128，且為必填（POST /messages 引用的就是這個）', () => {
            const p = deref(spec, spec.paths['/bridge/v1/messages'].post.parameters[0]);
            assert.equal(p.name, 'Idempotency-Key');
            assert.equal(p.in, 'header');
            assert.equal(p.required, true);
            assert.equal(p.schema.maxLength, 128);
        });
    });
});

describe('x-status 與 conformance 登記', () => {
    const implemented = ops.filter((o) => o.op['x-status'] === 'implemented');

    it('每個 implemented 操作都登記在 CONFORMANCE，且登記的操作都存在於規格並是 implemented', () => {
        assert.deepEqual(sorted(implemented.map((o) => o.key)), sorted(Object.keys(CONFORMANCE)));
    });

    it('登記的狀態碼 ∪ UNEXERCISED（附原因）= 規格為該操作列出的狀態碼（兩邊都不能多）', () => {
        for (const { key, op } of implemented) {
            const specStatuses = Object.keys(op.responses);
            const waived = Object.keys(UNEXERCISED).filter((k) => k.startsWith(`${key} `)).map((k) => k.slice(key.length + 1));
            for (const w of waived) assert.ok(String(UNEXERCISED[`${key} ${w}`]).length > 10, `${key} ${w} 要寫明原因`);
            assert.equal(new Set(CONFORMANCE[key]).size, CONFORMANCE[key].length, `${key} 登記有重複`);
            assert.deepEqual(sorted([...CONFORMANCE[key], ...waived]), sorted(specStatuses), key);
        }
    });

    it('planned 操作不可被登記為 conformance，也不可被實際路由出去（GET /messages/{message_id} 不提供）', async () => {
        const planned = ops.filter((o) => o.op['x-status'] === 'planned');
        assert.ok(planned.some((o) => o.key === 'GET /bridge/v1/messages/{message_id}'), '規格應記載 GET /messages/{message_id} 為 planned');
        const env = { BRIDGE_ENABLED: '1' };
        for (const { key, method, path } of planned) {
            assert.ok(!(key in CONFORMANCE), `${key} 是 planned，不應登記 conformance`);
            const concrete = path.replace(/\{[^}]+\}/g, 'msg_0123456789abcdef');
            const url = new URL(`https://worker.example.com${concrete}`);
            const headers = { Authorization: 'Bearer brk_aaaaaa_not-a-real-key', 'X-Bot-Id': 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01' };
            const res = await handleBridge(new Request(url, { method, headers }), env, url.pathname);
            assert.equal(res.status, 404, `${key} 應回 404（未提供）`);
            const body = await res.json();
            assert.ok(body.success === false || body.error, '404 本文應為錯誤');
        }
    });

    it('partial 操作（若有）至少要有描述其缺口的 description', () => {
        for (const { key, op } of ops.filter((o) => o.op['x-status'] === 'partial')) {
            assert.ok(typeof op.description === 'string' && op.description.length > 0, `${key} 是 partial，要說明缺什麼`);
        }
    });
});
