import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Run tests against workspace package sources, no build step required.
    alias: {
      '@ai-email/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@ai-email/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
