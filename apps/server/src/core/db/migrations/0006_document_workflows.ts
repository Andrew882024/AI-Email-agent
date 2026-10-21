/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import { type Kysely, sql } from 'kysely';

const up = [
  // Document workflows record matching mail in a Google Sheet / Doc / PDF.
  `ALTER TABLE workflows DROP CONSTRAINT workflows_type_check`,
  `ALTER TABLE workflows ADD CONSTRAINT workflows_type_check
    CHECK (type IN ('label', 'todo', 'archive', 'star_read', 'document'))`,
  // The values extracted from a matching email (document workflows), by field name.
  `ALTER TABLE workflow_decisions ADD COLUMN output jsonb`,
];

const down = [
  `ALTER TABLE workflow_decisions DROP COLUMN IF EXISTS output`,
  `DELETE FROM workflows WHERE type = 'document'`,
  `ALTER TABLE workflows DROP CONSTRAINT workflows_type_check`,
  `ALTER TABLE workflows ADD CONSTRAINT workflows_type_check
    CHECK (type IN ('label', 'todo', 'archive', 'star_read'))`,
];

export async function upMigration(db: Kysely<any>): Promise<void> {
  for (const statement of up) await sql.raw(statement).execute(db);
}

export async function downMigration(db: Kysely<any>): Promise<void> {
  for (const statement of down) await sql.raw(statement).execute(db);
}
