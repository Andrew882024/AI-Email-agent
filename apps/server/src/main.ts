// Standalone server entry point (dev, or spawned by the Electron shell).
import {
  checkDatabase,
  ConfigError,
  loadConfig,
  migrateToLatest,
  openInSystemBrowser,
} from '@ai-email/core';
import { buildServer } from './server.js';
import { createServices } from './services.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const health = await checkDatabase(config.databaseUrl);
  if (!health.ok) {
    console.error(`✗ database: ${health.error}\n  ${health.hint}`);
    process.exit(1);
  }

  const services = createServices(config, { openExternal: openInSystemBrowser });
  await migrateToLatest(services.db);
  const app = await buildServer(services, { allowedOrigins: config.allowedOrigins });
  await app.listen({ host: '127.0.0.1', port: config.serverPort });
  await services.scheduler.start();
  services.logger.info(`API listening on http://127.0.0.1:${config.serverPort}`);
  console.log(`API listening on http://127.0.0.1:${config.serverPort}`);

  const shutdown = async () => {
    await app.close();
    await services.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? `✗ ${err.message}` : err);
  process.exit(1);
});
