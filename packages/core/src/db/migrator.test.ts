import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../../test/helpers/db.js';
import { migrateDown, migrateReset, migrateToLatest } from './migrator.js';

const APP_TABLES = [
  'accounts',
  'action_logs',
  'attachments',
  'labels',
  'message_labels',
  'messages',
  'oauth_tokens',
  'outbox_ops',
  'threads',
  'todos',
];

describe.skipIf(!testDatabaseUrl)('migrator', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase({ migrate: false });
  });
  afterAll(() => t?.destroy());

  const tables = async () => {
    const { rows } = await sql<{ tablename: string }>`
      select tablename from pg_tables
      where schemaname = 'public' and tablename not like 'kysely_%'
      order by tablename`.execute(t.db);
    return rows.map((r) => r.tablename);
  };

  it('migrates up, down and up again', async () => {
    const up = await migrateToLatest(t.db);
    expect(up.map((r) => [r.migrationName, r.status])).toEqual([['0001_init', 'Success']]);
    expect(await tables()).toEqual(APP_TABLES);

    expect(await migrateToLatest(t.db)).toEqual([]);

    const down = await migrateDown(t.db);
    expect(down.map((r) => [r.direction, r.status])).toEqual([['Down', 'Success']]);
    expect(await tables()).toEqual([]);

    await migrateToLatest(t.db);
    expect(await tables()).toEqual(APP_TABLES);
    await migrateReset(t.db);
    expect(await tables()).toEqual([]);
  });
});
