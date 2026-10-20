import type { Migration } from 'kysely/migration';
import { downMigration as down0001, upMigration as up0001 } from './0001_init.js';
import { downMigration as down0002, upMigration as up0002 } from './0002_sync.js';
import { downMigration as down0003, upMigration as up0003 } from './0003_rag.js';
import { downMigration as down0004, upMigration as up0004 } from './0004_chat.js';
import { downMigration as down0005, upMigration as up0005 } from './0005_workflows.js';
import { downMigration as down0006, upMigration as up0006 } from './0006_document_workflows.js';

// Registered explicitly (not read from disk) so migrations work the same from src, dist and a
// packaged Electron app. Names sort lexically; never rename or reorder an applied migration.
export const migrations: Record<string, Migration> = {
  '0001_init': { up: up0001, down: down0001 },
  '0002_sync': { up: up0002, down: down0002 },
  '0003_rag': { up: up0003, down: down0003 },
  '0004_chat': { up: up0004, down: down0004 },
  '0005_workflows': { up: up0005, down: down0005 },
  '0006_document_workflows': { up: up0006, down: down0006 },
};
