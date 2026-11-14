/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

// oauth_tokens and sync_state held one row per account; their columns move onto accounts.
// encrypted_refresh_token IS NULL means no stored Google token; full_sync_started_at IS NOT NULL
// means a full sync is in progress (as in 0002).
const up = [
  `ALTER TABLE accounts
    ADD COLUMN encrypted_refresh_token text,
    ADD COLUMN oauth_scopes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN oauth_updated_at timestamptz,
    ADD COLUMN full_sync_started_at timestamptz,
    ADD COLUMN full_sync_history_id text,
    ADD COLUMN full_sync_page_token text,
    ADD COLUMN full_sync_window_start timestamptz,
    ADD COLUMN full_sync_count integer NOT NULL DEFAULT 0,
    ADD COLUMN tasks_synced_at timestamptz`,
  `UPDATE accounts a SET
    encrypted_refresh_token = t.encrypted_refresh_token,
    oauth_scopes = t.scopes,
    oauth_updated_at = t.updated_at
  FROM oauth_tokens t WHERE t.account_id = a.id`,
  `UPDATE accounts a SET
    full_sync_started_at = s.full_sync_started_at,
    full_sync_history_id = s.full_sync_history_id,
    full_sync_page_token = s.full_sync_page_token,
    full_sync_window_start = s.full_sync_window_start,
    full_sync_count = s.full_sync_count,
    tasks_synced_at = s.tasks_synced_at
  FROM sync_state s WHERE s.account_id = a.id`,
  `DROP TABLE oauth_tokens`,
  `DROP TABLE sync_state`,
];

const down = [
  `CREATE TABLE oauth_tokens (
    account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    encrypted_refresh_token text NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `INSERT INTO oauth_tokens (account_id, encrypted_refresh_token, scopes, updated_at)
    SELECT id, encrypted_refresh_token, oauth_scopes, coalesce(oauth_updated_at, now())
    FROM accounts WHERE encrypted_refresh_token IS NOT NULL`,
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
  `INSERT INTO sync_state (account_id, full_sync_started_at, full_sync_history_id,
      full_sync_page_token, full_sync_window_start, full_sync_count, tasks_synced_at)
    SELECT id, full_sync_started_at, full_sync_history_id, full_sync_page_token,
      full_sync_window_start, full_sync_count, tasks_synced_at
    FROM accounts WHERE full_sync_started_at IS NOT NULL OR tasks_synced_at IS NOT NULL`,
  `ALTER TABLE accounts
    DROP COLUMN encrypted_refresh_token,
    DROP COLUMN oauth_scopes,
    DROP COLUMN oauth_updated_at,
    DROP COLUMN full_sync_started_at,
    DROP COLUMN full_sync_history_id,
    DROP COLUMN full_sync_page_token,
    DROP COLUMN full_sync_window_start,
    DROP COLUMN full_sync_count,
    DROP COLUMN tasks_synced_at`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
