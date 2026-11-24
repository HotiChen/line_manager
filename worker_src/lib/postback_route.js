/**
 * postback data 解析（LM-4A，契約草案 §A.1）
 *
 * 純函式，不碰 KV／網路。回傳值只含解析後的欄位，**不含原始 data**，
 * 呼叫端可以安心把結果（或原因碼）寫進 log／稽核。
 *
 *   lm:<action>[?query]                → { kind: 'lm', action, params }
 *   px:<product_key>:<action>[?query]  → { kind: 'px', productKey, action, params }
 *   沒有前綴                            → { kind: 'legacy' }（呼叫端自行處理 tag=／untag=）
 *   格式不合                            → { kind: 'invalid', reason }
 */

/** LINE postback data 的上限 */
export const POSTBACK_MAX_LENGTH = 300;

const MAX_PARAMS = 8;
const MAX_VALUE_LENGTH = 64;

const ACTION_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const PRODUCT_KEY_RE = /^[a-z][a-z0-9]{1,15}$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,15}$/;
/** 「看起來像前綴」：字母開頭、冒號結尾，且冒號前沒有 = & ? */
const PREFIX_LIKE_RE = /^[A-Za-z][A-Za-z0-9_-]*:/;

/** 原因碼（稽核用，值是穩定字串） */
export const REASON = Object.freeze({
    EMPTY: 'empty',
    TOO_LONG: 'too_long',
    UNKNOWN_PREFIX: 'unknown_prefix',
    BAD_PRODUCT_KEY: 'bad_product_key',
    BAD_ACTION: 'bad_action',
    TOO_MANY_PARAMS: 'too_many_params',
    BAD_PARAM_KEY: 'bad_param_key',
    PARAM_VALUE_TOO_LONG: 'param_value_too_long',
    DUPLICATE_PARAM: 'duplicate_param',
});

const invalid = (reason) => ({ kind: 'invalid', reason });

/**
 * 解析 query（不含開頭的 ?）。
 * @returns {{params: Object<string,string>}|{reason: string}}
 */
function parseQuery(query) {
    const params = {};
    if (query === '') return { params };
    const entries = [...new URLSearchParams(query)];
    if (entries.length > MAX_PARAMS) return { reason: REASON.TOO_MANY_PARAMS };
    for (const [key, value] of entries) {
        if (!PARAM_KEY_RE.test(key)) return { reason: REASON.BAD_PARAM_KEY };
        if (Object.hasOwn(params, key)) return { reason: REASON.DUPLICATE_PARAM };
        if (value.length > MAX_VALUE_LENGTH) return { reason: REASON.PARAM_VALUE_TOO_LONG };
        params[key] = value;
    }
    return { params };
}

/** 拆 "<action>[?query]" */
function parseActionAndQuery(rest) {
    const q = rest.indexOf('?');
    const action = q === -1 ? rest : rest.slice(0, q);
    if (!ACTION_RE.test(action)) return { reason: REASON.BAD_ACTION };
    const parsed = parseQuery(q === -1 ? '' : rest.slice(q + 1));
    if (parsed.reason) return parsed;
    return { action, params: parsed.params };
}

/**
 * @param {unknown} data - event.postback.data
 */
export function parsePostback(data) {
    if (typeof data !== 'string' || data === '') return invalid(REASON.EMPTY);
    if (data.length > POSTBACK_MAX_LENGTH) return invalid(REASON.TOO_LONG);

    if (data.startsWith('lm:')) {
        const r = parseActionAndQuery(data.slice(3));
        if (r.reason) return invalid(r.reason);
        return { kind: 'lm', action: r.action, params: r.params };
    }

    if (data.startsWith('px:')) {
        const rest = data.slice(3);
        const colon = rest.indexOf(':');
        const productKey = colon === -1 ? rest : rest.slice(0, colon);
        if (!PRODUCT_KEY_RE.test(productKey)) return invalid(REASON.BAD_PRODUCT_KEY);
        if (colon === -1) return invalid(REASON.BAD_ACTION);
        const r = parseActionAndQuery(rest.slice(colon + 1));
        if (r.reason) return invalid(r.reason);
        return { kind: 'px', productKey, action: r.action, params: r.params };
    }

    if (PREFIX_LIKE_RE.test(data)) return invalid(REASON.UNKNOWN_PREFIX);
    return { kind: 'legacy' };
}
