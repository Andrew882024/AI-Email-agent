import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../../test/helpers/db.js';
import { migrateDown, migrateReset, migrateToLatest } from './migrator.js';

const APP_TABLES = [
  'accounts',
  'action_logs',
  'attachments',
  'chat_files',
  'chat_messages',
  'chat_sessions',
  'email_embeddings',
  'labels',
  'memory_items',
  'message_labels',
  'messages',
  'oauth_tokens',
  'outbox_ops',
  'sync_state',
  'threads',
  'todos',
  'tool_runs',
  'workflow_decisions',
  'workflows',
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
    expect(up.map((r) => [r.migrationName, r.status])).toEqual([
      ['0001_init', 'Success'],
      ['0002_sync', 'Success'],
      ['0003_rag', 'Success'],
      ['0004_chat', 'Success'],
      ['0005_workflows', 'Success'],
    ]);
    expect(await tables()).toEqual(APP_TABLES);

    expect(await migrateToLatest(t.db)).toEqual([]);

    const workflowTables = ['workflow_decisions', 'workflows'];
    expect((await migrateDown(t.db)).map((r) => r.migrationName)).toEqual(['0005_workflows']);
    expect(await tables()).toEqual(APP_TABLES.filter((name) => !workflowTables.includes(name)));
    const chatTables = [
      ...workflowTables,
      'chat_files',
      'chat_messages',
      'chat_sessions',
      'memory_items',
      'tool_runs',
    ];
    expect((await migrateDown(t.db)).map((r) => r.migrationName)).toEqual(['0004_chat']);
    expect(await tables()).toEqual(APP_TABLES.filter((name) => !chatTables.includes(name)));
    expect((await migrateDown(t.db)).map((r) => r.migrationName)).toEqual(['0003_rag']);
    expect(await tables()).toEqual(
      APP_TABLES.filter((name) => name !== 'email_embeddings' && !chatTables.includes(name)),
    );
    const down = await migrateDown(t.db);
    expect(down.map((r) => [r.migrationName, r.direction])).toEqual([['0002_sync', 'Down']]);
    expect(await tables()).toEqual(
      APP_TABLES.filter(
        (name) => !['sync_state', 'email_embeddings', ...chatTables].includes(name),
      ),
    );
    await migrateDown(t.db);
    expect(await tables()).toEqual([]);

    await migrateToLatest(t.db);
    expect(await tables()).toEqual(APP_TABLES);
    await migrateReset(t.db);
    expect(await tables()).toEqual([]);
  });
});
