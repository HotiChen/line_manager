import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
    js.configs.recommended,
    jsdoc.configs['flat/recommended'],
    {
        files: ['**/*.js', '**/*.mjs'],
        plugins: {
            jsdoc,
        },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.es2021,
                // Workspace specific globals
                'bootstrap': 'readonly',
                'Swiper': 'readonly',
                'Sortable': 'readonly',
                'Chart': 'readonly',
                'io': 'readonly'
            }
        },
        rules: {
            // Code Audit: Naming
            'camelcase': ['error', { properties: 'never', ignoreDestructuring: true }],

            // Code Audit: Logic & Variables
            'no-var': 'error',
            'prefer-const': 'error',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'eqeqeq': ['error', 'always'],

            // Code Audit: JSDoc Rules
            'jsdoc/require-jsdoc': ['warn', {
                require: {
                    FunctionDeclaration: true,
                    MethodDefinition: true,
                    ClassDeclaration: true,
                    ArrowFunctionExpression: false,
                    FunctionExpression: false
                }
            }],
            'jsdoc/require-param': 'warn',
            'jsdoc/require-returns': 'warn',
            'jsdoc/check-param-names': 'warn',
            'jsdoc/check-tag-names': 'warn',
            'jsdoc/require-description': 'warn'
        }
    },
    // ── Bridge 邊界（LM-1A）──
    // 與 tests/unit/test_import_boundary.mjs 是同一組規則的兩層防線；改一邊要改另一邊
    // （放行清單見 tests/helpers/import_boundary.mjs 的 BRIDGE_ALLOWED_EXTERNAL）。
    {
        // (i) bridge/ 以外不得 import bridge/；worker_src/index.js 是 composition root，例外
        files: ['worker_src/**/*.js'],
        ignores: ['worker_src/bridge/**', 'worker_src/index.js'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['**/bridge', '**/bridge/**'],
                    message: 'worker_src/bridge/ 是獨立模組：只有 worker_src/index.js（composition root）可以 import 它。',
                }],
            }],
        },
    },
    {
        // (ii) bridge/ 只能 import 兄弟檔、lm_service.js 與明確放行的共用模組（其餘一律禁止，含 bare specifier）
        files: ['worker_src/bridge/**/*.js'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    // 排除放行清單後的所有 specifier（ESLint 的 gitignore 風格 negation 不處理 ./ 與 ../ 開頭的路徑，
                    // 所以改用 regex）
                    regex: '^(?!\\./[^/]+\\.js$|\\.\\./lm_service\\.js$|\\.\\./lib/(line_api|crypto_util|kv_schema|utils)\\.js$|\\.\\./middleware/rate_limiter\\.js$)',
                    message: 'bridge/ 只能 import 兄弟檔、../lm_service.js 與放行的共用模組；要用 LM 內部的東西請在 lm_service.js 加一個窄函式。',
                }],
            }],
        },
    },
    {
        ignores: [
            'node_modules/**',
            'js/flex2html.js',    // Ignore generated/minified files
            'js/flex2html.min.js',
            '**/*.tmp',
            '**/*.bak',
            '**/*.backup*'
        ]
    }
];
