/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

/** Must match EMBEDDING_DIMENSIONS (and 0003). */
const DIMENSIONS = 1536;

// message_labels, attachments and email_embeddings each hung off one message; they become columns
// of messages:
// - label_ids: sorted Gmail label ids (system ones too: INBOX, UNREAD, STARRED, ...). Still no FK
//   to labels: history events can reference a label before the next labels.list refresh.
// - attachments: Attachment objects ({ partId, attachmentId?, filename, mimeType, size,
//   contentId? }), ordered by partId.
// - embedding*: one embedding per message; embedded_at is compared with updated_at (same database
//   clock) to find stale embeddings, so writing them must not touch updated_at.
// One UPDATE fills all three so each message row is rewritten once.
const up = [
  `ALTER TABLE messages
    ADD COLUMN label_ids text[] NOT NULL DEFAULT '{}',
    ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN embedding vector(${DIMENSIONS}),
    ADD COLUMN embedding_model text,
    ADD COLUMN embedding_hash text,
    ADD COLUMN embedded_at timestamptz`,
  `UPDATE messages m SET
    label_ids = coalesce((
      SELECT array_agg(ml.label_id ORDER BY ml.label_id) FROM message_labels ml
      WHERE ml.account_id = m.account_id AND ml.message_id = m.id
    ), '{}'),
    attachments = coalesce((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'partId', a.part_id, 'attachmentId', a.attachment_id, 'filename', a.filename,
          'mimeType', a.mime_type, 'size', a.size, 'contentId', a.content_id
        )) ORDER BY a.part_id)
      FROM attachments a WHERE a.account_id = m.account_id AND a.message_id = m.id
    ), '[]'),
    (embedding, embedding_model, embedding_hash, embedded_at) = (
      SELECT e.embedding, e.model, e.content_hash, e.embedded_at FROM email_embeddings e
      WHERE e.account_id = m.account_id AND e.message_id = m.id
    )`,
  `CREATE INDEX messages_label_ids_idx ON messages USING gin (label_ids)`,
  `CREATE INDEX messages_embedding_hnsw ON messages USING hnsw (embedding vector_cosine_ops)`,
  `DROP TABLE message_labels`,
  `DROP TABLE attachments`,
  `DROP TABLE email_embeddings`,
];

const down = [
  `CREATE TABLE message_labels (
    account_id uuid NOT NULL,
    message_id text NOT NULL,
    label_id text NOT NULL,
    PRIMARY KEY (account_id, message_id, label_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages (account_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX message_labels_label_idx ON message_labels (account_id, label_id, message_id)`,
  `INSERT INTO message_labels (account_id, message_id, label_id)
    SELECT DISTINCT account_id, id, unnest(label_ids) FROM messages`,
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
  `INSERT INTO attachments (account_id, message_id, part_id, attachment_id, filename, mime_type,
      size, content_id)
    SELECT m.account_id, m.id, a ->> 'partId', a ->> 'attachmentId', coalesce(a ->> 'filename', ''),
      a ->> 'mimeType', coalesce((a ->> 'size')::integer, 0), a ->> 'contentId'
    FROM messages m, jsonb_array_elements(m.attachments) a`,
  `CREATE TABLE email_embeddings (
    account_id uuid NOT NULL,
    message_id text NOT NULL,
    model text NOT NULL,
    content_hash text NOT NULL,
    embedding vector(${DIMENSIONS}) NOT NULL,
    embedded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, message_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages (account_id, id) ON DELETE CASCADE
  )`,
  `INSERT INTO email_embeddings (account_id, message_id, model, content_hash, embedding, embedded_at)
    SELECT account_id, id, embedding_model, embedding_hash, embedding, embedded_at
    FROM messages WHERE embedding IS NOT NULL`,
  `CREATE INDEX email_embeddings_hnsw ON email_embeddings USING hnsw (embedding vector_cosine_ops)`,
  `DROP INDEX messages_embedding_hnsw`,
  `DROP INDEX messages_label_ids_idx`,
  `ALTER TABLE messages
    DROP COLUMN label_ids,
    DROP COLUMN attachments,
    DROP COLUMN embedding,
    DROP COLUMN embedding_model,
    DROP COLUMN embedding_hash,
    DROP COLUMN embedded_at`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
