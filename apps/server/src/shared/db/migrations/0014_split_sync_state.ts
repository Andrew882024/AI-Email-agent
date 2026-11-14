/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

// Sync progress gets its own table again, owned by the sync module (accounts belongs to auth).
// It now also holds the incremental sync point (history_id) and last_full_sync_at, which lived on
// accounts since 0001. full_sync_started_at IS NOT NULL means a full sync is in progress.
const SYNC_COLUMNS = [
  'history_id',
  'last_full_sync_at',
  'full_sync_started_at',
  'full_sync_history_id',
  'full_sync_page_token',
  'full_sync_window_start',
  'full_sync_count',
  'tasks_synced_at',
];

const up = [
  `CREATE TABLE sync_state (
    account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    history_id text,
    last_full_sync_at timestamptz,
    full_sync_started_at timestamptz,
    full_sync_history_id text,
    full_sync_page_token text,
    full_sync_window_start timestamptz,
    full_sync_count integer NOT NULL DEFAULT 0,
    tasks_synced_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `INSERT INTO sync_state (account_id, ${SYNC_COLUMNS.join(', ')})
    SELECT id, ${SYNC_COLUMNS.join(', ')} FROM accounts`,
  `ALTER TABLE accounts ${SYNC_COLUMNS.map((c) => `DROP COLUMN ${c}`).join(', ')}`,
];

const down = [
  `ALTER TABLE accounts
    ADD COLUMN history_id text,
    ADD COLUMN last_full_sync_at timestamptz,
    ADD COLUMN full_sync_started_at timestamptz,
    ADD COLUMN full_sync_history_id text,
    ADD COLUMN full_sync_page_token text,
    ADD COLUMN full_sync_window_start timestamptz,
    ADD COLUMN full_sync_count integer NOT NULL DEFAULT 0,
    ADD COLUMN tasks_synced_at timestamptz`,
  `UPDATE accounts a SET ${SYNC_COLUMNS.map((c) => `${c} = s.${c}`).join(', ')}
    FROM sync_state s WHERE s.account_id = a.id`,
  `DROP TABLE sync_state`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
