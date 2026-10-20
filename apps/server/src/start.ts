import { type AppConfig, checkDatabase, migrateToLatest } from '@ai-email/core';
import { buildServer } from './server.js';
import { createServices, type HostCapabilities } from './services.js';

/** Why the server couldn't start, in a form a host (CLI, Electron) can show the user. */
export class StartupError extends Error {
  override name = 'StartupError';
  constructor(
    readonly reason: 'database',
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface StartOptions {
  /** 0 picks a free port. Defaults to config.serverPort. */
  port?: number;
  /** Built web app to serve at / (same origin as the API). */
  webRoot?: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Check the database, migrate, wire services, listen on loopback, and start background sync. */
export async function startServer(
  config: AppConfig,
  host: HostCapabilities,
  options: StartOptions = {},
): Promise<RunningServer> {
  const health = await checkDatabase(config.databaseUrl);
  if (!health.ok)
    throw new StartupError('database', health.error ?? 'Database unavailable', health.hint);

  const services = createServices(config, host);
  try {
    await migrateToLatest(services.db);
    const app = await buildServer(services, {
      allowedOrigins: config.allowedOrigins,
      webRoot: options.webRoot,
    });
    await app.listen({ host: '127.0.0.1', port: options.port ?? config.serverPort });
    await services.scheduler.start();
    const { port } = app.server.address() as { port: number };
    services.logger.info({ port }, 'API listening');
    return {
      port,
      async close() {
        await app.close();
        await services.close();
      },
    };
  } catch (err) {
    await services.close();
    throw err;
  }
}
