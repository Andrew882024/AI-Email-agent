import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;

export function createDb(databaseUrl: string, options: { maxConnections?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: options.maxConnections ?? 10 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
