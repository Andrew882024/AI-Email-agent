/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

const up = [
  // One conversation with the assistant. Older messages get folded into `summary` (rolling
  // summary) once the history grows; summarized_through is the last chat_messages.id folded in.
  `CREATE TABLE chat_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT 'New chat',
    summary text,
    summarized_through bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX chat_sessions_account_idx ON chat_sessions (account_id, updated_at DESC)`,
  `CREATE TABLE chat_messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'model')),
    parts jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX chat_messages_session_idx ON chat_messages (session_id, id)`,
  // Each tool call the assistant makes; calls needing the user's approval wait here.
  `CREATE TABLE tool_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
    message_id bigint NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
    position integer NOT NULL,
    call_id text,
    tool text NOT NULL,
    input jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('awaiting_approval', 'done', 'error', 'rejected')),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  )`,
  `CREATE INDEX tool_runs_message_idx ON tool_runs (message_id, position)`,
  // Long-lived facts about the user shared by all sessions of the account.
  `CREATE TABLE memory_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    content text NOT NULL,
    category text NOT NULL,
    source_session_id uuid REFERENCES chat_sessions (id) ON DELETE SET NULL,
    embedding vector(1536),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX memory_items_account_idx ON memory_items (account_id, updated_at DESC)`,
  `CREATE TABLE chat_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size integer NOT NULL,
    storage_path text NOT NULL,
    extracted_text text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
];

const down = ['chat_files', 'memory_items', 'tool_runs', 'chat_messages', 'chat_sessions'].map(
  (t) => `DROP TABLE IF EXISTS ${t}`,
);

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
