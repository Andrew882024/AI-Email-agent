/* eslint-disable @typescript-eslint/no-explicit-any -- migrations run against any schema version, per Kysely docs */
import type { Kysely } from 'kysely';
import { type MigrationResult, Migrator, NO_MIGRATIONS } from 'kysely/migration';
import { migrations } from './migrations/index.js';

function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({ db, provider: { getMigrations: async () => migrations } });
}

async function run(
  result: Promise<{ error?: unknown; results?: MigrationResult[] }>,
): Promise<MigrationResult[]> {
  const { error, results } = await result;
  if (error) throw error;
  return results ?? [];
}

export function migrateToLatest(db: Kysely<any>): Promise<MigrationResult[]> {
  return run(createMigrator(db).migrateToLatest());
}

/** Revert the most recently applied migration. */
export function migrateDown(db: Kysely<any>): Promise<MigrationResult[]> {
  return run(createMigrator(db).migrateDown());
}

/** Revert every migration (drops all app tables). */
export function migrateReset(db: Kysely<any>): Promise<MigrationResult[]> {
  return run(createMigrator(db).migrateTo(NO_MIGRATIONS));
}
