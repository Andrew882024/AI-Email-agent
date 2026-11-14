import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // This project's own root: the editor lints all apps in one process and can't tell them apart.
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { languageOptions: { globals: globals.node } },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  // Layering, as in the web app: components reach global state only through the hooks in state/;
  // api/ is stateless (requests and validation only).
  {
    files: ['src/components/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@tanstack/react-query',
                'zustand',
                '**/state/store',
                '**/state/query-client',
              ],
              message: 'Use the hooks in src/state/ to read or change global state.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/api/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                '@tanstack/react-query',
                'zustand',
                '**/state/**',
                '**/components/**',
              ],
              message: 'api/ only requests and validates data; it keeps no state.',
            },
          ],
        },
      ],
    },
  },
  // Chrome loads these as single files: they may only import types.
  {
    files: ['src/background.ts', 'src/gmail/content.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['*'], allowTypeImports: true, message: 'Type imports only.' }] },
      ],
    },
  },
  prettier,
);
