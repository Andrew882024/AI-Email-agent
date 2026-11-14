// Wires the core services for command-line tools (the server will have its own composition root).
import { join } from 'node:path';
import { AUTH_CALLBACK_PATH, GoogleOAuthService } from '../core/auth/google-auth.js';
import { AesGcmSecretCipher } from '../core/auth/secret-cipher.js';
import { EncryptedTokenStore } from '../core/auth/token-store.js';
import { loadConfig } from '../core/config/env.js';
import { createDb } from '../core/db/connection.js';
import { createPgRepositories } from '../core/db/pg/index.js';
import { EventBus } from '../core/events/event-bus.js';
import { GoogleGatewayProvider } from '../core/google/gateways.js';
import { ActionLogger } from '../core/logging/action-logger.js';
import { createSystemLogger } from '../core/logging/system-logger.js';
import { MailSync } from '../core/sync/mail-sync.js';
import { MailboxService } from '../core/sync/mailbox.js';
import { OutboxWorker } from '../core/sync/outbox-worker.js';
import { SyncScheduler } from '../core/sync/scheduler.js';
import { TasksSync } from '../core/sync/tasks-sync.js';

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
    redirectUri: `${config.appUrl}${AUTH_CALLBACK_PATH}`,
    accounts: repos.accounts,
    tokens: new EncryptedTokenStore(repos.oauthTokens, new AesGcmSecretCipher(config.appSecretKey)),
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
