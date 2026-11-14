// Wires the core services for command-line tools (the server will have its own composition root).
import { createMailboxMirror } from '../mailbox/index.js';
import { join } from 'node:path';
import { AUTH_CALLBACK_PATH, GoogleOAuthService } from '../auth/index.js';
import { AesGcmSecretCipher } from '../auth/index.js';
import { EncryptedTokenStore } from '../auth/index.js';
import { loadConfig } from '../shared/config/env.js';
import { createDb } from '../shared/db/connection.js';
import { createPgRepositories } from '../repositories.js';
import { EventBus } from '../shared/events/event-bus.js';
import { GoogleGatewayProvider } from '../shared/google/gateways.js';
import { ActionLogger } from '../shared/logging/action-logger.js';
import { createSystemLogger } from '../shared/logging/system-logger.js';
import { MailSync } from '../sync/index.js';
import { MailboxService } from '../mailbox/index.js';
import { OutboxWorker } from '../sync/index.js';
import { SyncScheduler } from '../sync/index.js';
import { TasksSync } from '../sync/index.js';

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
  const mirror = createMailboxMirror(repos);
  const mailSync = new MailSync({
    mailbox: mirror,
    syncState: repos.syncState,
    gateways,
    events,
    actions,
    logger,
    windowDays: config.sync.windowDays,
  });
  const outbox = new OutboxWorker({ mailbox: mirror, gateways, events, actions, logger, mailSync });
  const tasksSync = new TasksSync(
    { mailbox: mirror, syncState: repos.syncState },
    gateways,
    events,
  );
  const scheduler = new SyncScheduler({
    mailbox: mirror,
    accounts: repos.accounts,
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
