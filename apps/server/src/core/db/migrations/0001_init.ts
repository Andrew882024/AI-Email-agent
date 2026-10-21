/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

// Labels (system ones too: INBOX, UNREAD, STARRED, ...) live only in message_labels; read/starred/inbox
// flags are derived from it so there is a single source of truth.
// message_labels.label_id has no FK to labels: history events can reference a label before the next
// labels.list refresh has stored it.
const up = [
  `CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    google_sub text NOT NULL UNIQUE,
    display_name text,
    history_id text,
    last_full_sync_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE oauth_tokens (
    account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    encrypted_refresh_token text NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE labels (
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL CHECK (type IN ('system', 'user')),
    color_background text,
    color_text text,
    PRIMARY KEY (account_id, id)
  )`,
  `CREATE TABLE threads (
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    id text NOT NULL,
    snippet text,
    last_message_at timestamptz,
    PRIMARY KEY (account_id, id)
  )`,
  `CREATE TABLE messages (
    account_id uuid NOT NULL,
    id text NOT NULL,
    thread_id text NOT NULL,
    history_id text,
    message_id_header text,
    in_reply_to text,
    references_header text,
    from_addr jsonb,
    to_addrs jsonb NOT NULL DEFAULT '[]',
    cc_addrs jsonb NOT NULL DEFAULT '[]',
    bcc_addrs jsonb NOT NULL DEFAULT '[]',
    reply_to_addrs jsonb NOT NULL DEFAULT '[]',
    subject text NOT NULL DEFAULT '',
    snippet text NOT NULL DEFAULT '',
    body_text text,
    body_html text,
    internal_date timestamptz NOT NULL,
    size_estimate integer,
    has_attachments boolean NOT NULL DEFAULT false,
    fts tsvector GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig,
        coalesce(subject, '') || ' ' ||
        coalesce(from_addr ->> 'name', '') || ' ' ||
        coalesce(from_addr ->> 'email', '') || ' ' ||
        left(coalesce(body_text, ''), 100000))
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, id),
    FOREIGN KEY (account_id, thread_id) REFERENCES threads (account_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX messages_date_idx ON messages (account_id, internal_date DESC, id DESC)`,
  `CREATE INDEX messages_thread_idx ON messages (account_id, thread_id)`,
  `CREATE INDEX messages_fts_idx ON messages USING gin (fts)`,
  `CREATE TABLE message_labels (
    account_id uuid NOT NULL,
    message_id text NOT NULL,
    label_id text NOT NULL,
    PRIMARY KEY (account_id, message_id, label_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages (account_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX message_labels_label_idx ON message_labels (account_id, label_id, message_id)`,
  `CREATE TABLE attachments (
    account_id uuid NOT NULL,
    message_id text NOT NULL,
    part_id text NOT NULL,
    attachment_id text,
    filename text NOT NULL DEFAULT '',
    mime_type text NOT NULL,
    size integer NOT NULL DEFAULT 0,
    content_id text,
    PRIMARY KEY (account_id, message_id, part_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages (account_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE todos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    message_id text,
    google_task_id text NOT NULL,
    tasklist_id text NOT NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'needsAction' CHECK (status IN ('needsAction', 'completed')),
    due timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, google_task_id)
  )`,
  `CREATE INDEX todos_message_idx ON todos (account_id, message_id)`,
  `CREATE TABLE outbox_ops (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    op text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX outbox_ops_pending_idx ON outbox_ops (next_attempt_at, id) WHERE status = 'pending'`,
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

const tables = [
  'action_logs',
  'outbox_ops',
  'todos',
  'attachments',
  'message_labels',
  'messages',
  'threads',
  'labels',
  'oauth_tokens',
  'accounts',
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const table of tables) await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(db);
}
