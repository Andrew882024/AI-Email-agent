/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

// Tool runs move onto the model message that made the calls: chat_messages.tool_runs is a JSON
// array of { id, position, callId?, tool, input, status, result?, createdAt, resolvedAt? },
// ordered by position. Run ids are kept, so approval links stay valid. The GIN index finds a run
// by id.
const up = [
  `ALTER TABLE chat_messages ADD COLUMN tool_runs jsonb NOT NULL DEFAULT '[]'`,
  `UPDATE chat_messages m SET tool_runs = r.runs
  FROM (
    SELECT message_id, jsonb_agg(
      jsonb_build_object(
        'id', id, 'position', position, 'tool', tool, 'input', input, 'status', status,
        'createdAt', created_at
      )
      || CASE WHEN call_id IS NULL THEN '{}' ELSE jsonb_build_object('callId', call_id) END
      || CASE WHEN result IS NULL THEN '{}' ELSE jsonb_build_object('result', result) END
      || CASE WHEN resolved_at IS NULL THEN '{}'
        ELSE jsonb_build_object('resolvedAt', resolved_at) END
      ORDER BY position
    ) AS runs
    FROM tool_runs GROUP BY message_id
  ) r
  WHERE r.message_id = m.id`,
  `CREATE INDEX chat_messages_tool_runs_idx ON chat_messages USING gin (tool_runs jsonb_path_ops)`,
  `DROP TABLE tool_runs`,
];

const down = [
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
  `INSERT INTO tool_runs (id, session_id, message_id, position, call_id, tool, input, status,
      result, created_at, resolved_at)
    SELECT (r ->> 'id')::uuid, m.session_id, m.id, (r ->> 'position')::integer, r ->> 'callId',
      r ->> 'tool', r -> 'input', r ->> 'status', r -> 'result', (r ->> 'createdAt')::timestamptz,
      (r ->> 'resolvedAt')::timestamptz
    FROM chat_messages m, jsonb_array_elements(m.tool_runs) r`,
  `DROP INDEX chat_messages_tool_runs_idx`,
  `ALTER TABLE chat_messages DROP COLUMN tool_runs`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
