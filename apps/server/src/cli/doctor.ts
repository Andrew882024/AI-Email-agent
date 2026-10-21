// Startup self-check: validates configuration and database connectivity.
import { ConfigError, loadConfig } from '../core/config/env.js';
import { checkDatabase } from '../core/db/health.js';

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`✗ config\n${err.message}\nCopy .env.example to .env and fill it in.`);
      return 1;
    }
    throw err;
  }
  console.log('✓ config');

  const health = await checkDatabase(config.databaseUrl);
  if (!health.ok) {
    console.error(`✗ database: ${health.error}\n  ${health.hint}`);
    return 1;
  }
  console.log(`✓ database (Postgres ${health.serverVersion}, pgvector available)`);
  return 0;
}

process.exitCode = await main();
