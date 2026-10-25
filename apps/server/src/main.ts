// Server entry point: `pnpm server`.
import { ConfigError, loadConfig } from './core/index.js';
import { StartupError, startServer } from './start.js';

try {
  const server = await startServer(loadConfig());
  console.log(`Listening on port ${server.port}`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (err) {
  if (err instanceof StartupError)
    console.error(`✗ ${err.reason}: ${err.message}\n  ${err.hint ?? ''}`);
  else console.error(err instanceof ConfigError ? `✗ ${err.message}` : err);
  process.exit(1);
}
