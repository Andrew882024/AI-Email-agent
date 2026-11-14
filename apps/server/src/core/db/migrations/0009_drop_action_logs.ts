/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

// Actions are recorded in the system log (app.jsonl) only; GET /api/logs is gone.
// Reverting recreates the table empty: the dropped history is not restored.
const up = [`DROP TABLE action_logs`];

const down = [
  `CREATE TABLE action_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
    actor text NOT NULL,
    action text NOT NULL,
    target_ids text[] NOT NULL DEFAULT '{}',
    params jsonb,
    status text NOT NULL CHECK (status IN ('success', 'error')),
    error text,
    duration_ms integer
  )`,
  `CREATE INDEX action_logs_actor_idx ON action_logs (actor, id DESC)`,
  `CREATE INDEX action_logs_action_idx ON action_logs (action, id DESC)`,
  `CREATE INDEX action_logs_account_idx ON action_logs (account_id, id DESC)`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
