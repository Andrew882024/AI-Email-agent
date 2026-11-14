import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../testing/db.js';
import { migrateDown, migrateReset, migrateToLatest } from './migrator.js';

/** Every migration in order, with the app tables it creates and drops. */
const HISTORY: { name: string; adds?: string[]; drops?: string[] }[] = [
  {
    name: '0001_init',
    adds: [
      'accounts',
      'oauth_tokens',
      'labels',
      'threads',
      'messages',
      'message_labels',
      'attachments',
      'todos',
      'outbox_ops',
      'action_logs',
    ],
  },
  { name: '0002_sync', adds: ['sync_state'] },
  { name: '0003_rag', adds: ['email_embeddings'] },
  {
    name: '0004_chat',
    adds: ['chat_sessions', 'chat_messages', 'tool_runs', 'memory_items', 'chat_files'],
  },
  { name: '0005_workflows', adds: ['workflows', 'workflow_decisions'] },
  { name: '0006_document_workflows' },
  { name: '0007_sessions', adds: ['sessions'] },
  { name: '0008_drop_threads', drops: ['threads'] },
  { name: '0009_drop_action_logs', drops: ['action_logs'] },
  { name: '0010_merge_account_state', drops: ['oauth_tokens', 'sync_state'] },
  {
    name: '0011_merge_message_parts',
    drops: ['message_labels', 'attachments', 'email_embeddings'],
  },
  { name: '0012_merge_tool_runs', drops: ['tool_runs'] },
  { name: '0013_restore_action_logs', adds: ['action_logs'] },
];

/** The app tables after the first `count` migrations, sorted. */
function tablesAfter(count: number): string[] {
  const tables = new Set<string>();
  for (const { adds = [], drops = [] } of HISTORY.slice(0, count)) {
    for (const name of adds) tables.add(name);
    for (const name of drops) tables.delete(name);
  }
  return [...tables].sort();
}

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

  /** Revert migrations, newest first, until `name` has been reverted. */
  const revertThrough = async (name: string) => {
    for (;;) {
      const [result] = await migrateDown(t.db);
      if (!result) throw new Error(`${name} was never applied`);
      if (result.migrationName === name) return;
    }
  };

  it('migrates up, down one at a time and up again', async () => {
    const up = await migrateToLatest(t.db);
    expect(up.map((r) => [r.migrationName, r.status])).toEqual(
      HISTORY.map(({ name }) => [name, 'Success']),
    );
    expect(await tables()).toEqual(tablesAfter(HISTORY.length));
    expect(await migrateToLatest(t.db)).toEqual([]);

    for (let count = HISTORY.length; count > 0; count--) {
      const down = await migrateDown(t.db);
      expect(down.map((r) => [r.migrationName, r.direction])).toEqual([
        [HISTORY[count - 1]?.name, 'Down'],
      ]);
      expect(await tables()).toEqual(tablesAfter(count - 1));
    }
    expect(await tables()).toEqual([]);

    await migrateToLatest(t.db);
    expect(await tables()).toEqual(tablesAfter(HISTORY.length));
    await migrateReset(t.db);
    expect(await tables()).toEqual([]);
  });

  it('rebuilds threads from messages when 0008 is reverted', async () => {
    await migrateToLatest(t.db);
    await sql`insert into accounts (id, email, google_sub)
      values ('00000000-0000-0000-0000-000000000001', 'me@example.com', 'sub')`.execute(t.db);
    await sql`insert into messages (account_id, id, thread_id, snippet, internal_date) values
      ('00000000-0000-0000-0000-000000000001', 'm1', 'T', 'old', '2026-01-01T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000001', 'm2', 'T', 'new', '2026-01-02T00:00:00Z')`.execute(
      t.db,
    );

    await revertThrough('0008_drop_threads');
    const { rows } = await sql<{ id: string; snippet: string }>`
      select id, snippet from threads`.execute(t.db);
    expect(rows).toEqual([{ id: 'T', snippet: 'new' }]);

    await migrateToLatest(t.db);
    await migrateReset(t.db);
  });

  it('moves OAuth tokens and sync state onto accounts and back (0010)', async () => {
    await migrateToLatest(t.db);
    await revertThrough('0010_merge_account_state');
    await sql`insert into accounts (id, email, google_sub) values
      ('00000000-0000-0000-0000-000000000001', 'a@example.com', 'a'),
      ('00000000-0000-0000-0000-000000000002', 'b@example.com', 'b')`.execute(t.db);
    await sql`insert into oauth_tokens (account_id, encrypted_refresh_token, scopes)
      values ('00000000-0000-0000-0000-000000000001', 'cipher', '{gmail}')`.execute(t.db);
    await sql`insert into sync_state (account_id, full_sync_started_at, full_sync_history_id,
        full_sync_page_token, full_sync_count)
      values ('00000000-0000-0000-0000-000000000001', now(), '42', 'page-3', 7)`.execute(t.db);

    await migrateToLatest(t.db);
    const { rows } = await sql<Record<string, unknown>>`
      select email, encrypted_refresh_token, oauth_scopes, full_sync_history_id,
        full_sync_page_token, full_sync_count
      from accounts order by email`.execute(t.db);
    expect(rows).toEqual([
      {
        email: 'a@example.com',
        encrypted_refresh_token: 'cipher',
        oauth_scopes: ['gmail'],
        full_sync_history_id: '42',
        full_sync_page_token: 'page-3',
        full_sync_count: 7,
      },
      {
        email: 'b@example.com',
        encrypted_refresh_token: null,
        oauth_scopes: [],
        full_sync_history_id: null,
        full_sync_page_token: null,
        full_sync_count: 0,
      },
    ]);

    await revertThrough('0010_merge_account_state');
    const tokens = await sql<Record<string, unknown>>`
      select encrypted_refresh_token, scopes from oauth_tokens`.execute(t.db);
    expect(tokens.rows).toEqual([{ encrypted_refresh_token: 'cipher', scopes: ['gmail'] }]);
    const syncs = await sql<Record<string, unknown>>`
      select full_sync_history_id, full_sync_count from sync_state`.execute(t.db);
    expect(syncs.rows).toEqual([{ full_sync_history_id: '42', full_sync_count: 7 }]);

    await migrateToLatest(t.db);
    await migrateReset(t.db);
  });

  it('moves labels, attachments and embeddings onto messages and back (0011)', async () => {
    await migrateToLatest(t.db);
    await revertThrough('0011_merge_message_parts');
    const account = '00000000-0000-0000-0000-000000000001';
    const vector = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
    await sql`insert into accounts (id, email, google_sub)
      values (${account}, 'a@example.com', 'a')`.execute(t.db);
    await sql`insert into messages (account_id, id, thread_id, internal_date) values
      (${account}, 'm1', 'T', now()), (${account}, 'm2', 'T', now())`.execute(t.db);
    await sql`insert into message_labels (account_id, message_id, label_id) values
      (${account}, 'm1', 'UNREAD'), (${account}, 'm1', 'INBOX')`.execute(t.db);
    await sql`insert into attachments (account_id, message_id, part_id, attachment_id, filename,
        mime_type, size) values
      (${account}, 'm1', '2', null, 'b.png', 'image/png', 20),
      (${account}, 'm1', '1', 'att-1', 'a.pdf', 'application/pdf', 10)`.execute(t.db);
    await sql`insert into email_embeddings (account_id, message_id, model, content_hash, embedding)
      values (${account}, 'm1', 'model-a', 'hash-1', ${vector}::vector)`.execute(t.db);

    await migrateToLatest(t.db);
    const { rows } = await sql<Record<string, unknown>>`
      select id, label_ids, attachments, embedding_model, embedding_hash,
        embedding is not null as embedded
      from messages order by id`.execute(t.db);
    expect(rows).toEqual([
      {
        id: 'm1',
        label_ids: ['INBOX', 'UNREAD'],
        attachments: [
          {
            partId: '1',
            attachmentId: 'att-1',
            filename: 'a.pdf',
            mimeType: 'application/pdf',
            size: 10,
          },
          { partId: '2', filename: 'b.png', mimeType: 'image/png', size: 20 },
        ],
        embedding_model: 'model-a',
        embedding_hash: 'hash-1',
        embedded: true,
      },
      {
        id: 'm2',
        label_ids: [],
        attachments: [],
        embedding_model: null,
        embedding_hash: null,
        embedded: false,
      },
    ]);

    await revertThrough('0011_merge_message_parts');
    const labels = await sql<Record<string, unknown>>`
      select message_id, label_id from message_labels order by label_id`.execute(t.db);
    expect(labels.rows).toEqual([
      { message_id: 'm1', label_id: 'INBOX' },
      { message_id: 'm1', label_id: 'UNREAD' },
    ]);
    const files = await sql<Record<string, unknown>>`
      select part_id, attachment_id, filename, size from attachments order by part_id`.execute(
      t.db,
    );
    expect(files.rows).toEqual([
      { part_id: '1', attachment_id: 'att-1', filename: 'a.pdf', size: 10 },
      { part_id: '2', attachment_id: null, filename: 'b.png', size: 20 },
    ]);
    const embeddings = await sql<Record<string, unknown>>`
      select message_id, model, content_hash from email_embeddings`.execute(t.db);
    expect(embeddings.rows).toEqual([
      { message_id: 'm1', model: 'model-a', content_hash: 'hash-1' },
    ]);

    await migrateToLatest(t.db);
    await migrateReset(t.db);
  });

  it('moves tool runs onto their chat message and back, keeping ids (0012)', async () => {
    await migrateToLatest(t.db);
    await revertThrough('0012_merge_tool_runs');
    const account = '00000000-0000-0000-0000-000000000001';
    const session = '00000000-0000-0000-0000-0000000000a1';
    const run1 = '00000000-0000-0000-0000-0000000000b1';
    const run2 = '00000000-0000-0000-0000-0000000000b2';
    await sql`insert into accounts (id, email, google_sub)
      values (${account}, 'a@example.com', 'a')`.execute(t.db);
    await sql`insert into chat_sessions (id, account_id) values (${session}, ${account})`.execute(
      t.db,
    );
    const { rows: messages } = await sql<{ id: string }>`
      insert into chat_messages (session_id, role, parts) values
        (${session}, 'model', '[]'), (${session}, 'user', '[]')
      returning id`.execute(t.db);
    const modelMessage = messages[0]!.id;
    await sql`insert into tool_runs (id, session_id, message_id, position, call_id, tool, input,
        status, result, resolved_at) values
      (${run2}, ${session}, ${modelMessage}, 1, null, 'archive', '{"messageIds":["m2"]}',
        'awaiting_approval', '{"description":"Archive 1 email"}', null),
      (${run1}, ${session}, ${modelMessage}, 0, 'c1', 'star', '{"messageIds":["m1"]}',
        'done', '{"updated":1}', now())`.execute(t.db);

    await migrateToLatest(t.db);
    const { rows } = await sql<{ id: string; tool_runs: Record<string, unknown>[] }>`
      select id, tool_runs from chat_messages order by id`.execute(t.db);
    expect(rows.map((r) => r.tool_runs.map((run) => [run.id, run.position]))).toEqual([
      [
        [run1, 0],
        [run2, 1],
      ],
      [],
    ]);
    expect(rows[0]?.tool_runs[0]).toMatchObject({
      callId: 'c1',
      tool: 'star',
      input: { messageIds: ['m1'] },
      status: 'done',
      result: { updated: 1 },
      resolvedAt: expect.any(String),
    });
    expect(rows[0]?.tool_runs[1]).not.toHaveProperty('callId');
    expect(rows[0]?.tool_runs[1]).not.toHaveProperty('resolvedAt');

    await revertThrough('0012_merge_tool_runs');
    const back = await sql<Record<string, unknown>>`
      select id, message_id, position, call_id, status, result from tool_runs
      order by position`.execute(t.db);
    expect(back.rows).toEqual([
      {
        id: run1,
        message_id: modelMessage,
        position: 0,
        call_id: 'c1',
        status: 'done',
        result: { updated: 1 },
      },
      {
        id: run2,
        message_id: modelMessage,
        position: 1,
        call_id: null,
        status: 'awaiting_approval',
        result: { description: 'Archive 1 email' },
      },
    ]);

    await migrateToLatest(t.db);
    await migrateReset(t.db);
  });
});
