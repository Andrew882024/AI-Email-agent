import { describe, expect, it } from 'vitest';
import { checkDatabase } from './health.js';

describe('checkDatabase', () => {
  it('reports an unreachable server with a Docker hint', async () => {
    // Port 1 is reserved and never has Postgres listening.
    const health = await checkDatabase('postgres://u:p@127.0.0.1:1/db', 1000);
    expect(health.ok).toBe(false);
    expect(health.hint).toMatch(/pnpm db:up/);
  });

  const url = process.env.TEST_DATABASE_URL;
  it.skipIf(!url)('connects to the docker Postgres and finds pgvector', async () => {
    const health = await checkDatabase(url!);
    expect(health).toMatchObject({ ok: true, pgvectorAvailable: true });
    expect(health.serverVersion).toMatch(/^16\./);
  });
});
