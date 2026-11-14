/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

// threads was written on every sync but never read: thread lists are aggregated from messages.
// messages reached accounts only through it, so it now references accounts directly to keep
// "delete the account, its mail goes with it".
const up = [
  `ALTER TABLE messages DROP CONSTRAINT messages_account_id_thread_id_fkey`,
  `ALTER TABLE messages ADD CONSTRAINT messages_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE`,
  `DROP TABLE threads`,
];

const down = [
  `CREATE TABLE threads (
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    id text NOT NULL,
    snippet text,
    last_message_at timestamptz,
    PRIMARY KEY (account_id, id)
  )`,
  // Rebuild one row per thread from its newest message.
  `INSERT INTO threads (account_id, id, snippet, last_message_at)
    SELECT DISTINCT ON (account_id, thread_id) account_id, thread_id, snippet, internal_date
    FROM messages
    ORDER BY account_id, thread_id, internal_date DESC, id DESC`,
  `ALTER TABLE messages DROP CONSTRAINT messages_account_id_fkey`,
  `ALTER TABLE messages ADD CONSTRAINT messages_account_id_thread_id_fkey
    FOREIGN KEY (account_id, thread_id) REFERENCES threads (account_id, id) ON DELETE CASCADE`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
