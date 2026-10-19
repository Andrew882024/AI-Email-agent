// Usage: migrate [up|down|reset]   (default: up)
import { loadConfig } from '../config/env.js';
import { createDb } from '../db/connection.js';
import { migrateDown, migrateReset, migrateToLatest } from '../db/migrator.js';

const commands = { up: migrateToLatest, down: migrateDown, reset: migrateReset };
const name = (process.argv[2] ?? 'up') as keyof typeof commands;
const command = commands[name];
if (!command) {
  console.error(`Unknown command "${name}". Use: up | down | reset`);
  process.exit(1);
}

const db = createDb(loadConfig().databaseUrl, { maxConnections: 1 });
try {
  const results = await command(db);
  if (results.length === 0) console.log('Nothing to do.');
  for (const r of results)
    console.log(`${r.status === 'Success' ? '✓' : '✗'} ${r.direction} ${r.migrationName}`);
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
