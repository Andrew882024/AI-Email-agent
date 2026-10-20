/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

const up = [
  // Resumable full-sync checkpoint and Tasks polling cursor. full_sync_started_at IS NOT NULL
  // means a full sync is in progress.
  `CREATE TABLE sync_state (
    account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    full_sync_started_at timestamptz,
    full_sync_history_id text,
    full_sync_page_token text,
    full_sync_window_start timestamptz,
    full_sync_count integer NOT NULL DEFAULT 0,
    tasks_synced_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // A todo exists locally before its Google Task is created by the outbox worker.
  `ALTER TABLE todos ALTER COLUMN google_task_id DROP NOT NULL`,
  `ALTER TABLE todos ALTER COLUMN tasklist_id DROP NOT NULL`,
];

const down = [
  `DELETE FROM todos WHERE google_task_id IS NULL OR tasklist_id IS NULL`,
  `ALTER TABLE todos ALTER COLUMN google_task_id SET NOT NULL`,
  `ALTER TABLE todos ALTER COLUMN tasklist_id SET NOT NULL`,
  `DROP TABLE IF EXISTS sync_state`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
