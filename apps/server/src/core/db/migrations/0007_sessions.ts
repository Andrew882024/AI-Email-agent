/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

const up = [
  // Browser sign-ins. The id is the SHA-256 of the cookie's token, so a database leak can't be
  // replayed as a session.
  `CREATE TABLE sessions (
    id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  )`,
  `CREATE INDEX sessions_account_idx ON sessions (account_id)`,
];

const down = [`DROP TABLE IF EXISTS sessions`];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
