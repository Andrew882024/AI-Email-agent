import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Backend modules and which other modules each may depend on (src/shared depends on none).
const MODULES = {
  auth: [],
  mailbox: ['auth'],
  sync: ['auth', 'mailbox'],
  agent: ['auth', 'mailbox'],
};
const NAMES = Object.keys(MODULES);

/** Another module may only be imported through its index.js. */
const throughIndex = (name) => ({
  regex: `(^|/)${name}/(?!index\\.js$)`,
  message: `Import the ${name} module through ${name}/index.js, not its internal files.`,
});
const forbidden = (from, name) => ({
  regex: `(^|/)${name}/`,
  message: `${from} must not depend on the ${name} module.`,
});
const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // This project's own root: the editor lints both apps in one process and can't tell them apart.
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { languageOptions: { globals: globals.node } },
  // Entry points (server, services, CLI) wire every module, through their index files.
  { files: ['src/**/*.ts'], rules: restrict(NAMES.map(throughIndex)) },
  ...NAMES.map((name) => ({
    files: [`src/${name}/**/*.ts`],
    ignores: ['src/**/*.test.ts'],
    rules: restrict(
      NAMES.filter((other) => other !== name).map((other) =>
        MODULES[name].includes(other) ? throughIndex(other) : forbidden(name, other),
      ),
    ),
  })),
  {
    files: ['src/shared/**/*.ts'],
    rules: restrict(NAMES.map((name) => forbidden('src/shared', name))),
  },
  // Tests may wire several modules together, still only through their index files.
  {
    files: ['src/**/*.test.ts'],
    rules: restrict(NAMES.map(throughIndex)),
  },
  prettier,
);
