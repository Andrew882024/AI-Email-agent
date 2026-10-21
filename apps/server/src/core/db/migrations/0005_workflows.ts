/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

const up = [
  // A standing rule ("persistent": also handles new mail) or a one-time cleanup ("one_shot").
  // criteria/keywords are the model's description of matching mail; action says what to do.
  `CREATE TABLE workflows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name text NOT NULL,
    type text NOT NULL CHECK (type IN ('label', 'todo', 'archive', 'star_read')),
    mode text NOT NULL CHECK (mode IN ('persistent', 'one_shot')),
    instruction text NOT NULL,
    criteria text NOT NULL,
    keywords text[] NOT NULL DEFAULT '{}',
    sender_filter text,
    since timestamptz,
    action jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL CHECK (status IN ('previewing', 'awaiting_approval', 'active', 'paused', 'completed', 'failed')),
    error text,
    session_id uuid REFERENCES chat_sessions (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX workflows_account_idx ON workflows (account_id, created_at DESC)`,
  // One decision per workflow and message: the engine never handles a message twice.
  `CREATE TABLE workflow_decisions (
    workflow_id uuid NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    account_id uuid NOT NULL,
    message_id text NOT NULL,
    phase text NOT NULL CHECK (phase IN ('backfill', 'incremental')),
    match boolean NOT NULL,
    confidence real NOT NULL,
    reason text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('pending', 'applied', 'skipped', 'undone', 'failed')),
    error text,
    decided_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    PRIMARY KEY (workflow_id, message_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages (account_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX workflow_decisions_status_idx ON workflow_decisions (workflow_id, status)`,
];

const down = ['workflow_decisions', 'workflows'].map((t) => `DROP TABLE IF EXISTS ${t}`);

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
