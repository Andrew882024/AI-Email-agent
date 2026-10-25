import { type AppConfig, checkDatabase, migrateToLatest } from './core/index.js';
import { buildServer } from './server.js';
import { createServices } from './services.js';

/** Why the server couldn't start, in a form the command line can show the user. */
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

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Check the database, migrate, wire services, listen, and start background sync. */
export async function startServer(config: AppConfig): Promise<RunningServer> {
  const health = await checkDatabase(config.databaseUrl);
  if (!health.ok)
    throw new StartupError('database', health.error ?? 'Database unavailable', health.hint);

  const services = createServices(config);
  try {
    await migrateToLatest(services.db);
    const app = await buildServer(services, {
      appUrl: config.appUrl,
      allowedOrigins: config.allowedOrigins,
      webRoot: config.webRoot,
    });
    await app.listen({ host: config.serverHost, port: config.serverPort });
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
