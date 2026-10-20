// Composition root: wires the core modules into one set of services for the HTTP server.
import { join } from 'node:path';
import {
  ActionLogger,
  AesGcmSecretCipher,
  type AppConfig,
  type Db,
  type Logger,
  type Repositories,
  ConfigError,
  createDb,
  createEmailTools,
  createPgRepositories,
  createSystemLogger,
  EncryptedTokenStore,
  EventBus,
  GoogleGatewayProvider,
  GoogleOAuthService,
  MailboxService,
  MailSync,
  type OpenExternal,
  OutboxWorker,
  type SecretCipher,
  SyncScheduler,
  TasksSync,
  ToolRegistry,
} from '@ai-email/core';

/** Platform capabilities supplied by whoever hosts the server (Electron, or a plain Node process). */
export interface HostCapabilities {
  openExternal: OpenExternal;
  /** Encrypts stored tokens; defaults to AES-GCM keyed by APP_SECRET_KEY. Electron passes safeStorage. */
  cipher?: SecretCipher;
}

export interface Services {
  config: AppConfig;
  logger: Logger;
  db: Db;
  repos: Repositories;
  events: EventBus;
  auth: GoogleOAuthService;
  scheduler: SyncScheduler;
  tools: ToolRegistry;
  /** Stop background sync and close the database pool. */
  close(): Promise<void>;
}

export function createServices(config: AppConfig, host: HostCapabilities): Services {
  const cipher =
    host.cipher ??
    (config.appSecretKey
      ? new AesGcmSecretCipher(config.appSecretKey)
      : (() => {
          throw new ConfigError(
            'APP_SECRET_KEY is required to store Google tokens outside Electron (`openssl rand -base64 32`).',
          );
        })());
  const logger = createSystemLogger({
    level: config.logLevel,
    logDir: join(config.dataDir, 'logs'),
  });
  const db = createDb(config.databaseUrl);
  const repos = createPgRepositories(db);
  const events = new EventBus(logger);
  const actions = new ActionLogger(repos.actionLogs, logger);
  const auth = new GoogleOAuthService({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    accounts: repos.accounts,
    tokens: new EncryptedTokenStore(repos.oauthTokens, cipher),
    openExternal: host.openExternal,
    logger,
  });
  const gateways = new GoogleGatewayProvider(auth, {
    gmailUnitsPerMinute: config.sync.gmailQuotaPerMinute,
  });
  const mailSync = new MailSync({
    repos,
    gateways,
    events,
    actions,
    logger,
    windowDays: config.sync.windowDays,
  });
  const outbox = new OutboxWorker({ repos, gateways, events, actions, logger, mailSync });
  const tasksSync = new TasksSync(repos, gateways, events);
  const scheduler = new SyncScheduler({
    repos,
    auth,
    mailSync,
    tasksSync,
    outbox,
    events,
    logger,
    mailIntervalMs: config.sync.pollSeconds * 1000,
  });
  const mailbox = new MailboxService(repos, events);
  const tools = new ToolRegistry(actions).register(
    ...createEmailTools({ repos, mailbox, gateways, events }),
  );

  return {
    config,
    logger,
    db,
    repos,
    events,
    auth,
    scheduler,
    tools,
    async close() {
      await scheduler.stop();
      await db.destroy();
    },
  };
}
