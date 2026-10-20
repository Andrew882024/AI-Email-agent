// Standalone server entry point (development; the desktop app uses startServer directly).
import { ConfigError, loadConfig, openInSystemBrowser } from '@ai-email/core';
import { StartupError, startServer } from './start.js';

try {
  const server = await startServer(loadConfig(), { openExternal: openInSystemBrowser });
  console.log(`API listening on http://127.0.0.1:${server.port}`);
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
