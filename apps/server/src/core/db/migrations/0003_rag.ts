/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

/** Must match EMBEDDING_DIMENSIONS; HNSW indexes support at most 2000 dimensions for `vector`. */
const DIMENSIONS = 1536;

const up = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  // One embedding per message ("one chunk per email"). embedded_at is compared with
  // messages.updated_at (same database clock) to find stale embeddings.
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
  `CREATE INDEX email_embeddings_hnsw ON email_embeddings USING hnsw (embedding vector_cosine_ops)`,
  // Substring search for text the 'simple' tsvector parser can't segment (Chinese, Japanese, ...).
  `CREATE INDEX messages_subject_trgm ON messages USING gin (subject gin_trgm_ops)`,
  `CREATE INDEX messages_body_trgm ON messages USING gin ((left(coalesce(body_text, ''), 20000)) gin_trgm_ops)`,
];

const down = [
  `DROP INDEX IF EXISTS messages_body_trgm`,
  `DROP INDEX IF EXISTS messages_subject_trgm`,
  `DROP TABLE IF EXISTS email_embeddings`,
  `DROP EXTENSION IF EXISTS pg_trgm`,
  `DROP EXTENSION IF EXISTS vector`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
