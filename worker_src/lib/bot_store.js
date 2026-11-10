/**
 * bot_store — botId 收斂期間的唯一 KV 存取出口
 *
 * ## 問題
 *
 * 16 個 handler 與 5 個 lib 各自拼 `<domain>_${userId}` 當 key，綁的是「呼叫者
 * 本人」。後果有兩個：同一個人持有兩個官方帳號時，兩邊的會員混在一起；邀請來
 * 的同事登入後看到的是他自己的空命名空間，而不是那個 bot 的資料。
 *
 * 目標是 `bot:${botId}:<resource>`（見 kv_schema.js）。但正式環境已有 900 多筆
 * 舊 key，而且前端、webhook、後台同時在用 —— 一次切換等於要前後端同時上線，
 * 錯一個地方整個後台壞掉，而且舊資料已經搬走退不回來。
 *
 * ## 做法：雙讀雙寫
 *
 * 所有存取改走這裡，由這一層同時處理新舊 key：
 *
 *   讀：先讀 bot key，沒有才回退 v1 key（並記一次 fallback）
 *   寫：兩邊都寫
 *   刪：兩邊都刪
 *
 * 於是切換變成四個各自可退回的步驟：
 *
 *   1. handler 改走 bot_store（雙讀雙寫）   ← 新舊並存，隨時可退
 *   2. 回填：把舊 key 複製（不是搬移）到新 key
 *   3. fallback 計數歸零 → 回填完成
 *   4. 停雙寫、刪舊 key
 *
 * handler 的簽章不變（還是收 userId），botId 由 resolveBotId 在這一層算出來。
 * 這是刻意的：一次改 16 個簽章的 PR 沒有人能安全地 review。
 *
 * ## 降級路徑
 *
 * 兩種情況下只走 v1：
 *
 *   - 算不出 botId（舊 project 沒有 destination）。不可亂猜一個 —— 猜錯等於
 *     把資料寫進別的 bot 的命名空間。
 *   - key 組件含有 ':'（kv_schema 的分隔符，例如某個 tag 就叫 "a:b"）。
 *     BotKeys 會對這種組件丟 TypeError，這一層接住並只走 v1，
 *     而不是讓一個歷史資料造成的 500。
 *
 * 兩種都會 log，因為它們代表「這筆資料永遠不會進新命名空間」。
 */
import { BotKeys, UserKeys, V1Keys } from './kv_schema.js';
import { resolveBotId, resolveOwner } from './bot_context.js';

/**
 * 資源對照表 —— 新舊 key 的唯一對應關係。
 *
 * migration 也讀這張表，所以兩邊不可能對不上：漏一個資源會同時反映在
 * 回填與存取上，而不是只有其中一邊安靜地錯。
 *
 * `args` 是這個資源在 id 之後還需要幾個組件，用來擋下呼叫端少傳參數
 * （少傳時 BotKeys 會丟錯，但 V1Keys 會安靜地產生 `member_profile_U1_undefined`）。
 *
 * `copy` 決定回填時這個資源怎麼搬：
 *   'all'      複製到這個 owner 的每一個 bot（設定類，重複無害）
 *   'current'  只複製到 current_token 指向的那個 bot（CRM 類，重複會生出幽靈會員）
 *
 * `switched` 是這張表最重要的一欄：這個資源的 handler 是否已經改走 bot_store。
 *
 * 回填只處理 switched 的資源。還沒切換的 handler 仍然只寫舊 key，提前回填會
 * 留下一個沒人讀、卻在它切換的那一刻立刻「贏」的新 key —— 使用者的資料會
 * 跳回回填當時的版本。這一欄同時就是切換進度表。
 */
export const RESOURCES = {
    // ── 設定類：複製到每個 bot ──
    keywords: { bot: BotKeys.keywords, v1: V1Keys.keywordReplyList, args: 0, copy: 'all', switched: true },
    keywordStats: { bot: BotKeys.keywordStats, v1: V1Keys.keywordStats, args: 0, copy: 'all', switched: true },
    // 單筆關鍵字的 entity profile —— tag_system 會把標籤內嵌在這裡
    keyword: { bot: BotKeys.keyword, v1: V1Keys.keyword, args: 1, copy: 'all', switched: true },
    flexList: { bot: BotKeys.flexList, v1: V1Keys.flexList, args: 0, copy: 'all', switched: true },
        // 單筆 flex_${userId}_${id} 是比 flexList 更早的格式，目前沒有任何程式
    // 讀寫它。刻意不標 switched —— 回填一批沒有人會讀的死資料沒有意義。
    flex: { bot: BotKeys.flex, v1: V1Keys.flex, args: 1, copy: 'all', switched: false },
    images: { bot: BotKeys.images, v1: V1Keys.imageList, args: 0, copy: 'all', switched: true },
    imagemaps: { bot: BotKeys.imagemaps, v1: V1Keys.imagemap, args: 0, copy: 'all', switched: true },
    quickReplies: { bot: BotKeys.quickReplies, v1: V1Keys.quickReplyList, args: 0, copy: 'all', switched: true },
        welcome: { bot: BotKeys.welcome, v1: V1Keys.welcomeMessage, args: 0, copy: 'all', switched: true },
        tierConfig: { bot: BotKeys.tierConfig, v1: V1Keys.tierConfig, args: 0, copy: 'all', switched: true },
    segmentedRichMenuRules: {
        bot: BotKeys.segmentedRichMenuRules,
        v1: V1Keys.segmentedRichMenuRules,
        args: 0,
        copy: 'all',
        switched: true,
    },
        richMenuMeta: { bot: BotKeys.richMenuMeta, v1: V1Keys.richmenuMeta, args: 1, copy: 'all', switched: true },

    // ── CRM 與統計類：只複製到 current bot ──
    members: { bot: BotKeys.members, v1: V1Keys.memberList, args: 0, copy: 'current', switched: true },
    member: { bot: BotKeys.member, v1: V1Keys.memberProfile, args: 1, copy: 'current', switched: true },
    memberLog: { bot: BotKeys.memberLog, v1: V1Keys.memberLog, args: 1, copy: 'current', switched: true },
    tags: { bot: BotKeys.tags, v1: V1Keys.tagList, args: 0, copy: 'current', switched: true },
        tagEntities: {
        bot: BotKeys.tagEntities,
        v1: V1Keys.tagEntities,
        args: 2,
        copy: 'current',
        switched: true,
        // 第一個 id（entityType）在舊 key 裡位於 userId 之前
        // （`tag_${entityType}s_${userId}_${tag}`），所以沒辦法用單一前綴列出來。
        // 這份清單與 tag_system.js 的 ENTITY_RESOURCE 一致，回填靠它逐型列舉。
        entityTypes: ['member', 'keyword', 'richmenu', 'message'],
    },
    messageStats: { bot: BotKeys.messageStats, v1: V1Keys.messageStats, args: 0, copy: 'current', switched: true },
    message: { bot: BotKeys.message, v1: V1Keys.message, args: 1, copy: 'current', switched: true },
};

/**
 * 人的資料，不屬於任何 bot。
 *
 * 判斷標準跟 kv_schema 一樣：換一個 bot 之後這筆資料還有意義嗎？
 * profile 是「這個登入的人是誰」，所以在這裡，而且它沒有雙讀雙寫的問題
 * —— 新舊 key 都只綁 userId，單純改名。
 */
export const USER_RESOURCES = {
    profile: { next: UserKeys.profile, v1: V1Keys.profile },
};

/**
 * 組出一個 bot key；組件不合法時回 null 而不是丟錯。
 *
 * BotKeys 對含有 ':' 的組件丟 TypeError 是對的（那是跨命名空間寫入的唯一防線），
 * 但在這一層丟錯會把一個歷史資料問題變成 500。接住它、回 null、只走 v1。
 */
function usableComponent(value) {
    return typeof value === 'string' && value !== '' && !value.includes(':');
}

function tryBotKey(builder, botId, args) {
    try {
        return builder(botId, ...args);
    } catch {
        return null;
    }
}

/**
 * KV 的四個操作都包一層 try/catch：這一層在每個請求的熱路徑上，
 * 一次 KV 抖動不該讓整個請求 500。讀失敗回 null（等同沒有資料），
 * 寫失敗往上丟（呼叫端必須知道自己沒存成功）。
 */
async function readText(env, key) {
    if (!key) return null;
    try {
        return await env.KV_LINE_STORAGE.get(key);
    } catch {
        return null;
    }
}

/**
 * BotStore —— 一個請求、一個使用者、一個 bot 的存取介面。
 *
 * 不要跨請求重用：botId 來自使用者當下選的 bot，他可能在兩個請求之間切換。
 */
export class BotStore {
    /**
     * @param {Object} env
     * @param {string} userId  認證解析出來的呼叫者（舊 key 的命名空間）
     * @param {string|null} botId 他當下選定的 bot，算不出來時為 null
     */
    constructor(env, userId, botId) {
        this.env = env;
        this.userId = userId;
        this.botId = botId || null;
        /** 這次請求中有幾次讀取回退到舊 key。歸零代表回填完成。 */
        this.fallbacks = [];
    }

    /** 只有舊命名空間可用（算不出 botId） */
    get legacyOnly() {
        return this.botId === null;
    }

    /**
     * 一個資源的新舊 key。
     *
     * @returns {{bot: string|null, v1: string}}
     */
    keys(resource, ...args) {
        const spec = RESOURCES[resource];
        if (!spec) throw new TypeError(`bot_store: unknown resource '${resource}'`);
        if (args.length !== spec.args) {
            throw new TypeError(
                `bot_store: resource '${resource}' expects ${spec.args} id(s), got ${args.length}`
            );
        }

        // v1 也可能組不出來：以 botId 建立的 store（webhook 路徑）在反查不到
        // owner 時沒有 userId 可用。那種情況下只走新命名空間 —— 總比把資料
        // 寫進 `member_profile_null_...` 好。
        const v1 = usableComponent(this.userId) ? spec.v1(this.userId, ...args) : null;
        const bot = usableComponent(this.botId) ? tryBotKey(spec.bot, this.botId, args) : null;

        if (this.botId && bot === null) {
            console.warn(`[bot_store] unmappable resource=${resource} — key 組件含有分隔符，只走舊命名空間`);
        }
        if (bot === null && v1 === null) {
            throw new TypeError(
                `bot_store: resource '${resource}' 既沒有 botId 也沒有 userId，無法組出任何 key`
            );
        }

        return { bot, v1 };
    }

    /**
     * 讀原始字串。新 key 優先，沒有才回退舊 key。
     *
     * 「沒有」只看 null。空字串是一筆真實資料（例如被清空的 welcome 設定），
     * 回退會把它變回舊值 —— 那是使用者剛剛才刪掉的東西。
     */
    async getText(resource, ...args) {
        const { bot, v1 } = this.keys(resource, ...args);

        if (bot) {
            const fresh = await readText(this.env, bot);
            if (fresh !== null) return fresh;
        }

        if (!v1) return null;

        const legacy = await readText(this.env, v1);

        // 只有「有新 key 可試、卻讀不到」才算回退。算不出 botId 時走舊 key 是
        // 常態而不是落後，把它算進去會讓這個計數永遠不歸零 —— 而第 3 步
        // （fallback 歸零 → 回填完成）正是靠它判斷。
        if (legacy !== null && bot) {
            this.fallbacks.push(resource);
            console.warn(`[bot_store] legacy_fallback resource=${resource} botId=${this.botId}`);
        }
        return legacy;
    }

    /**
     * 讀並 parse。壞掉的 JSON 回 fallback 而不是丟錯 —— 舊資料裡確實有
     * 存成純字串的欄位，讓它們把請求打成 500 沒有意義。
     */
    async get(resource, ...args) {
        const raw = await this.getText(resource, ...args);
        if (raw === null) return null;
        try {
            return JSON.parse(raw);
        } catch {
            console.warn(`[bot_store] unparseable resource=${resource}`);
            return null;
        }
    }

    /** 讀並 parse，沒有資料時回 fallback（省掉每個呼叫端自己寫 `|| []`） */
    async getOr(resource, fallback, ...args) {
        const value = await this.get(resource, ...args);
        return value === null ? fallback : value;
    }

    /**
     * 兩邊都寫。
     *
     * 順序是「先新後舊」，而且新 key 寫失敗時不寫舊 key。
     * 反過來寫的話，新 key 寫失敗而舊 key 成功，會留下一個比舊值更舊的
     * 新 key —— 而讀取優先新 key，使用者就看到自己剛改的東西變回去了。
     * 現在這個順序下，任一邊單獨失敗，讀出來的都還是最新值。
     */
    async put(resource, value, ...args) {
        const { bot, v1 } = this.keys(resource, ...args);
        const payload = typeof value === 'string' ? value : JSON.stringify(value);

        if (bot) await this.env.KV_LINE_STORAGE.put(bot, payload);
        if (v1) await this.env.KV_LINE_STORAGE.put(v1, payload);
    }

    /**
     * 兩邊都刪。
     *
     * 只刪一邊的話，雙讀會從另一邊把它讀回來 —— 刪除看起來沒有生效。
     */
    async del(resource, ...args) {
        const { bot, v1 } = this.keys(resource, ...args);
        if (bot) await this.env.KV_LINE_STORAGE.delete(bot);
        if (v1) await this.env.KV_LINE_STORAGE.delete(v1);
    }

    /**
     * 列出某個帶 id 的資源實際存在哪些 id（兩個命名空間的聯集）。
     *
     * 供需要掃過全部會員的地方使用（例如重算等級）。回聯集而不是只回新的，
     * 因為回填期間兩邊都可能有獨有的項目。
     *
     * @param {string} resource 必須是 args === 1 的資源
     * @returns {Promise<string[]>} 排序後的 id
     */
    async listIds(resource) {
        const spec = RESOURCES[resource];
        if (!spec) throw new TypeError(`bot_store: unknown resource '${resource}'`);
        if (spec.args !== 1) {
            throw new TypeError(`bot_store: listIds 只支援單一 id 的資源，'${resource}' 需要 ${spec.args} 個`);
        }

        const ids = new Set();

        // 用一個不可能出現在真實 id 裡的哨兵值切出前綴，避免在這裡重拼 key 格式
        const SENTINEL = '\u0000ID\u0000';

        async function collect(env, prefix) {
            if (!prefix) return;
            let cursor;
            do {
                let page;
                try {
                    page = await env.KV_LINE_STORAGE.list({ prefix, cursor });
                } catch {
                    return;
                }
                for (const key of page.keys || []) {
                    const id = key.name.slice(prefix.length);
                    if (id !== '') ids.add(id);
                }
                cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor);
        }

        if (usableComponent(this.userId)) {
            const v1Prefix = spec.v1(this.userId, SENTINEL).split(SENTINEL)[0];
            await collect(this.env, v1Prefix);
        }

        if (usableComponent(this.botId)) {
            const botTemplate = tryBotKey(spec.bot, this.botId, [SENTINEL]);
            if (botTemplate) await collect(this.env, botTemplate.split(SENTINEL)[0]);
        }

        return [...ids].sort();
    }

    // ── 人的資料（單純改名，沒有 bot 維度）──

    /**
     * 一個 user 資源的新舊 key。
     *
     * UserKeys 對空值或含分隔符的 userId 丟 TypeError。未認證路由上的
     * userId 是 null（index.js 刻意不信任自報的身分），在那裡丟錯會變成
     * 500 —— 所以跟 bot key 一樣接住它，只走舊命名空間。
     *
     * @returns {{next: string|null, v1: string}}
     */
    userKeys(resource) {
        const spec = USER_RESOURCES[resource];
        if (!spec) throw new TypeError(`bot_store: unknown user resource '${resource}'`);

        let next = null;
        try {
            next = spec.next(this.userId);
        } catch {
            console.warn(`[bot_store] unmappable user resource=${resource} — userId 不可用`);
        }

        return { next, v1: spec.v1(this.userId) };
    }

    /** 讀一筆 user 資源，新 key 優先 */
    async getUser(resource) {
        const { next, v1 } = this.userKeys(resource);

        if (next) {
            const fresh = await readText(this.env, next);
            if (fresh !== null) {
                try {
                    return JSON.parse(fresh);
                } catch {
                    return null;
                }
            }
        }

        const raw = await readText(this.env, v1);
        if (raw === null) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /** 寫一筆 user 資源，兩邊都寫 */
    async putUser(resource, value) {
        const { next, v1 } = this.userKeys(resource);
        const payload = typeof value === 'string' ? value : JSON.stringify(value);

        if (next) await this.env.KV_LINE_STORAGE.put(next, payload);
        await this.env.KV_LINE_STORAGE.put(v1, payload);
    }
}

/**
 * 開一個 BotStore。
 *
 * 每個 handler 在進入點呼叫一次，之後所有 KV 存取都走它。
 *
 * @param {Object} env
 * @param {string} userId 認證解析出來的呼叫者 —— 絕不可用 body 或 query 裡自報的
 * @returns {Promise<BotStore>}
 */
export async function openBotStore(env, userId) {
    const botId = await resolveBotId(env, userId);
    if (!botId) {
        console.warn(`[bot_store] no_botid userId=${userId} — 只走舊命名空間`);
    }
    return new BotStore(env, userId, botId);
}

/**
 * 兩邊都已知時的建構函式 —— webhook 路徑用這個。
 *
 * ## 為什麼 webhook 不能用 openBotStore
 *
 * `openBotStore` 的 botId 來自 `resolveBotId(userId)`，也就是「這個人在後台
 * 選的那個 bot」。webhook 進來時那是錯的答案：事件屬於 LINE 的 destination
 * 指定的那個官方帳號，而 owner 可能正在後台看另一個。
 *
 * 一個持有兩個帳號的 owner，A 帳號收到的訊息會被寫進 B 帳號的命名空間 ——
 * 而且不會有任何錯誤，只是會員跑到隔壁去。
 *
 * webhook.js 同時握有 destination（botId）與反查出來的 userId，所以直接把
 * 兩個都給進來，不要在這一層再猜一次。
 *
 * @param {Object} env
 * @param {string|null} userId 舊命名空間用；null 時只走新命名空間
 * @param {string|null} botId  新命名空間用；null 時只走舊命名空間
 */
export function openBotStoreFor(env, userId, botId) {
    return new BotStore(env, userId || null, botId || null);
}

/**
 * 只知道 botId 時的建構函式（反查 owner 以取得舊命名空間）。
 *
 * 反查不到 owner 時仍可用，只是只走新命名空間 —— 在回填完成之前那等於
 * 讀不到舊資料，所以呼叫端應該優先用 openBotStoreFor 把 userId 一起給進來。
 *
 * @param {Object} env
 * @param {string} botId
 */
export async function openBotStoreForBot(env, botId) {
    const ownerId = await resolveOwner(env, botId);
    if (!ownerId) {
        console.warn(`[bot_store] no_owner botId=${botId} — 只走新命名空間，讀不到舊資料`);
    }
    return new BotStore(env, ownerId, botId);
}
