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
