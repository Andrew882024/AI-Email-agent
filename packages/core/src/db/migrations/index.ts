import type { Migration } from 'kysely/migration';
import { downMigration as down0001, upMigration as up0001 } from './0001_init.js';

// Registered explicitly (not read from disk) so migrations work the same from src, dist and a
// packaged Electron app. Names sort lexically; never rename or reorder an applied migration.
export const migrations: Record<string, Migration> = {
  '0001_init': { up: up0001, down: down0001 },
};
