import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from '../../src/db/connection.js';
import { migrateToLatest } from '../../src/db/migrator.js';

/** Set by `pnpm test:integration`; DB tests are skipped without it. */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export interface TestDatabase {
  db: Db;
  destroy(): Promise<void>;
}

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A throwaway database per test file, so files can run in parallel. */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set');
  const name = `ai_email_test_${randomBytes(6).toString('hex')}`;
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  const db = createDb(url.toString(), { maxConnections: 4 });
  if (options.migrate ?? true) await migrateToLatest(db);
  return {
    db,
    async destroy() {
      await db.destroy();
      await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}
