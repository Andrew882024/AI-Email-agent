// Wires the core services for command-line tools (the server will have its own composition root).
import { join } from 'node:path';
import { GoogleOAuthService } from '../auth/google-auth.js';
import { openInSystemBrowser } from '../auth/open-external.js';
import { AesGcmSecretCipher } from '../auth/secret-cipher.js';
import { EncryptedTokenStore } from '../auth/token-store.js';
import { loadConfig } from '../config/env.js';
import { createDb } from '../db/connection.js';
import { createPgRepositories } from '../db/pg/index.js';
import { EventBus } from '../events/event-bus.js';
import { GoogleGatewayProvider } from '../google/gateways.js';
import { ActionLogger } from '../logging/action-logger.js';
import { createSystemLogger } from '../logging/system-logger.js';
import { MailSync } from '../sync/mail-sync.js';
import { MailboxService } from '../sync/mailbox.js';
import { OutboxWorker } from '../sync/outbox-worker.js';
import { SyncScheduler } from '../sync/scheduler.js';
import { TasksSync } from '../sync/tasks-sync.js';

export function createCliContext() {
  const config = loadConfig();
  if (!config.appSecretKey) {
    console.error('✗ APP_SECRET_KEY is required. Generate one with `openssl rand -base64 32`.');
    process.exit(1);
  }
  const logger = createSystemLogger({
    level: config.logLevel,
    logDir: join(config.dataDir, 'logs'),
    stdout: false,
  });
  const db = createDb(config.databaseUrl, { maxConnections: 5 });
  const repos = createPgRepositories(db);
  const events = new EventBus(logger);
  const actions = new ActionLogger(repos.actionLogs, logger);
  const auth = new GoogleOAuthService({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    accounts: repos.accounts,
    tokens: new EncryptedTokenStore(repos.oauthTokens, new AesGcmSecretCipher(config.appSecretKey)),
    openExternal: openInSystemBrowser,
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
  return {
    config,
    db,
    repos,
    events,
    auth,
    mailSync,
    outbox,
    tasksSync,
    scheduler,
    mailbox: new MailboxService(repos, events),
  };
}
