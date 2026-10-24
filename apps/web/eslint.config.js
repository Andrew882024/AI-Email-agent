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
  // This project's own root: the editor lints both apps in one process and can't tell them apart.
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { languageOptions: { globals: globals.node } },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  // Layering: pages/components keep their own state with useState and reach global state only
  // through the hooks in state/; api/ is stateless (requests and validation only).
  {
    files: ['src/pages/**', 'src/components/**', 'src/router/**'],
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
                '**/pages/**',
                '**/router/**',
              ],
              message: 'api/ only requests and validates data; it keeps no state.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
