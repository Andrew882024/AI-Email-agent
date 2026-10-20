// Bundles the main process and the server process (so the packaged app needs no node_modules)
// and copies the built web UI next to them.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

// Google OAuth desktop client, embedded at build time (Google treats desktop client secrets as
// non-confidential). Taken from the environment or the repo's .env.
const dotenv = existsSync(join(root, '.env'))
  ? parseEnv(readFileSync(join(root, '.env'), 'utf8'))
  : {};
const embedded = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || dotenv.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || dotenv.GOOGLE_CLIENT_SECRET || '',
};
if (!embedded.GOOGLE_CLIENT_ID || !embedded.GOOGLE_CLIENT_SECRET) {
  console.warn('! GOOGLE_CLIENT_ID/SECRET not found; set them in the app config.env instead.');
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
run('pnpm --filter "@ai-email/desktop^..." build'); // core, server
run('pnpm --filter @ai-email/web build');

rmSync(join(here, 'dist'), { recursive: true, force: true });
rmSync(join(here, 'web'), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  logLevel: 'warning',
  external: ['electron'],
};
await build({
  ...common,
  entryPoints: [join(here, 'src/main.ts')],
  format: 'cjs',
  outfile: join(here, 'dist/main.cjs'),
  define: { __EMBEDDED_CONFIG__: JSON.stringify(embedded) },
});
await build({
  ...common,
  entryPoints: [join(here, 'src/server-child.ts')],
  format: 'esm',
  outfile: join(here, 'dist/server-child.mjs'),
  // Optional native/edge drivers that pg only loads on request.
  external: [...common.external, 'pg-native', 'cloudflare:sockets'],
  // Bundled CommonJS dependencies still call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
cpSync(join(root, 'apps/web/dist'), join(here, 'web'), { recursive: true });
console.log('✓ desktop bundles ready');
