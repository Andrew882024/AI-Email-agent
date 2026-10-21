import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // This project's own root: the editor lints both apps in one process and can't tell them apart.
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { languageOptions: { globals: globals.node } },
  prettier,
);
