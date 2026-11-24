/**
 * 契約測試共用工具（LM-1D）：載入 docs/integration/bridge-v1.yaml，並用它檢查真實回應。
 *
 * 只給測試用，不屬於 worker_src（Worker 本身不讀 YAML）。
 *   - loadSpec()               解析 YAML（`yaml` 套件）
 *   - deref(spec, node)        解開 `$ref: '#/...'`（可連環）
 *   - operations(spec)         列出所有 path × method
 *   - checkResponse(...)       狀態碼、標頭、本文是否符合規格中該操作該狀態碼的定義
 *   - CONFORMANCE / UNEXERCISED  conformance 測試登記的「每個 implemented 操作實際打過哪些狀態碼」
 *
 * JSON Schema 驗證用 ajv（OpenAPI 3.0 的 schema 是 draft-04/05 風格的子集：`nullable` 由 ajv 內建支援，
 * `example`、`x-*` 等未知關鍵字在 strict:false 下忽略；不裝 ajv-formats，date-time 與 uri 在這裡明確檢查）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import Ajv from 'ajv';

export const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'integration', 'bridge-v1.yaml');
export const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

let cached;
export function loadSpec() {
    if (!cached) cached = parse(readFileSync(SPEC_PATH, 'utf8'));
    return cached;
}

/** 解開 `#/a/b/c` 形式的 $ref（只支援本檔內的指標）。找不到就丟錯。 */
export function resolvePointer(spec, ref) {
    assert.ok(typeof ref === 'string' && ref.startsWith('#/'), `只支援本檔內的 $ref：${ref}`);
    let node = spec;
    for (const raw of ref.slice(2).split('/')) {
        const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        assert.ok(node !== null && typeof node === 'object' && Object.hasOwn(node, part), `$ref 找不到：${ref}`);
        node = node[part];
    }
    return node;
}

export function deref(spec, node, depth = 0) {
    assert.ok(depth < 10, '$ref 迴圈');
    if (node && typeof node === 'object' && typeof node.$ref === 'string') return deref(spec, resolvePointer(spec, node.$ref), depth + 1);
    return node;
}

/** 走遍整份文件，回傳所有 $ref 字串 */
export function collectRefs(node, out = []) {
    if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
    else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (k === '$ref' && typeof v === 'string') out.push(v);
            else collectRefs(v, out);
        }
    }
    return out;
}

/** @returns {{key: string, method: string, path: string, op: object, pathItem: object}[]}  key 例：`GET /bridge/v1/health` */
export function operations(spec) {
    const list = [];
    for (const [path, pathItem] of Object.entries(spec.paths)) {
        for (const method of METHODS) {
            if (pathItem[method]) list.push({ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, op: pathItem[method], pathItem });
        }
    }
    return list;
}

// ───────────────────────── JSON Schema 驗證 ─────────────────────────

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function makeAjv(extra = {}) {
    const ajv = new Ajv({ strict: false, allErrors: true, ...extra });
    ajv.addFormat('date-time', { type: 'string', validate: (s) => DATE_TIME_RE.test(s) && !Number.isNaN(Date.parse(s)) });
    ajv.addFormat('uri', {
        type: 'string',
        validate: (s) => {
            try {
                return /^[a-z][a-z0-9+.-]*:/i.test(s) && Boolean(new URL(s));
            } catch {
                return false;
            }
        },
    });
    return ajv;
}

const ajvBody = makeAjv();
const ajvHeader = makeAjv({ coerceTypes: true }); // 標頭值都是字串，integer 要先轉型
const compiled = new Map();

function compile(spec, schema, ajv, cacheKey) {
    const id = `${cacheKey}:${JSON.stringify(schema)}`;
    if (!compiled.has(id)) {
        // 把整份 components 掛在根上，`$ref: '#/components/schemas/X'` 就能由 ajv 解開
        compiled.set(id, ajv.compile({ ...schema, components: { schemas: spec.components.schemas } }));
    }
    return compiled.get(id);
}

/** 以規格中的 schema 驗證一個值；失敗時丟出含 ajv 錯誤的 AssertionError */
export function validateAgainst(spec, schema, value, label = 'value') {
    const validate = compile(spec, schema, ajvBody, 'body');
    const ok = validate(value);
    assert.ok(ok, `${label} 不符合規格 schema：${JSON.stringify(validate.errors)}\n實際：${JSON.stringify(value)}`);
}

// ───────────────────────── 回應檢查 ─────────────────────────

/**
 * 檢查一個真實回應是否符合規格：
 *   (a) 狀態碼在該操作的 responses 內
 *   (b) 本文符合該狀態碼的 schema（沒有 content 的回應本文必須為空）
 *   (c) 規格列出且 required 的標頭都在，且值符合 schema（有列出但非 required 的標頭，出現時也要符合）
 *   (d) 引用 Error schema 的回應：`{error:{code,message,retryable}}` 恰好這三個欄位，code 在 enum 內（由 schema 驗證）
 *
 * @param {object} spec
 * @param {string} opKey 例 `POST /bridge/v1/messages`
 * @param {Response} res
 * @param {string} text 已讀出的本文
 * @returns {{status: string, body: any, response: object}}
 */
export function checkResponse(spec, opKey, res, text) {
    const found = operations(spec).find((o) => o.key === opKey);
    assert.ok(found, `規格裡沒有操作 ${opKey}`);
    const status = String(res.status);
    const declared = found.op.responses && found.op.responses[status];
    assert.ok(declared, `${opKey} 回了 ${status}，規格只列：${Object.keys(found.op.responses || {}).join(', ')}\n本文：${text.slice(0, 300)}`);
    const response = deref(spec, declared);

    // 標頭
    for (const [name, rawHeader] of Object.entries(response.headers || {})) {
        const header = deref(spec, rawHeader);
        const value = res.headers.get(name);
        if (value === null) {
            assert.ok(!header.required, `${opKey} ${status}：規格要求標頭 ${name}，實際沒有`);
            continue;
        }
        if (header.schema) {
            const copy = { value };
            const validate = compile(spec, { type: 'object', properties: { value: header.schema } }, ajvHeader, 'header');
            assert.ok(validate(copy), `${opKey} ${status}：標頭 ${name}=${JSON.stringify(value)} 不符合 schema：${JSON.stringify(validate.errors)}`);
        }
    }

    // 本文
    const json = response.content && response.content['application/json'];
    let body = null;
    if (json) {
        const type = res.headers.get('Content-Type') || '';
        assert.ok(type.startsWith('application/json'), `${opKey} ${status}：Content-Type 應為 application/json，實際 ${type}`);
        try {
            body = JSON.parse(text);
        } catch {
            assert.fail(`${opKey} ${status}：本文不是 JSON：${text.slice(0, 200)}`);
        }
        validateAgainst(spec, json.schema, body, `${opKey} ${status} 本文`);
        if (json.schema.$ref === '#/components/schemas/Error') {
            assert.deepEqual(Object.keys(body), ['error'], `${opKey} ${status}：Error 本文頂層只能有 error`);
            assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'retryable'], `${opKey} ${status}：error 欄位`);
        }
    } else {
        assert.equal(text, '', `${opKey} ${status}：規格沒有 content，本文應為空`);
    }
    return { status, body, response };
}

// ───────────────────────── conformance 登記 ─────────────────────────

/**
 * 每個 `x-status: implemented` 操作，conformance 測試實際打到的狀態碼（test_bridge_contract_conformance.mjs
 * 結尾會核對「實際打到的 == 這裡登記的」；test_bridge_contract_spec.mjs 核對「登記 ∪ UNEXERCISED == 規格列出的」）。
 */
export const CONFORMANCE = Object.freeze({
    'GET /bridge/v1/health': ['200', '503'],
    'GET /bridge/v1/link/authorize': ['302', '400', '503'],
    'POST /bridge/v1/links/token': ['200', '400', '401', '429', '503'],
    'GET /bridge/v1/links/{link_id}': ['200', '401', '403', '404', '503'],
    'DELETE /bridge/v1/links/{link_id}': ['204', '401', '403', '404', '503'],
    'POST /bridge/v1/links/{link_id}/rotate-key': ['200', '401', '403', '404', '503'],
    'POST /bridge/v1/contacts/bind-tokens': ['201', '400', '401', '403', '429', '503'],
    'GET /bridge/v1/contacts/{external_contact_ref}': ['200', '401', '403', '404', '503'],
    'DELETE /bridge/v1/contacts/{external_contact_ref}': ['204', '401', '403', '404', '503'],
    'PUT /bridge/v1/contacts/{external_contact_ref}/segment': ['204', '400', '401', '403', '404', '409', '429', '503'],
    'POST /bridge/v1/messages': ['200', '400', '401', '402', '403', '409', '413', '422', '429', '502', '503'],
    'POST /bridge/v1/raw/push': ['200', '400', '401', '402', '403', '404', '409', '413', '422', '429', '502', '503'],
    'POST /bridge/v1/raw/multicast': ['200', '400', '401', '402', '403', '409', '413', '422', '429', '502', '503'],
});

/** 規格列出、但 conformance 沒有打的狀態碼（必須寫明原因；沒有就不要加） */
export const UNEXERCISED = Object.freeze({});
