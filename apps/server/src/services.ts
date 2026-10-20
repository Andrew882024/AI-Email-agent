// Composition root: wires the core modules into one set of services for the HTTP server.
import { join } from 'node:path';
import {
  ActionLogger,
  ChatAgent,
  ChatFileStore,
  createWorkflowTools,
  WorkflowEngine,
  GoogleDriveDocumentSink,
  GeminiProvider,
  MemoryService,
  AesGcmSecretCipher,
  type AppConfig,
  type Db,
  type Logger,
  type Repositories,
  ConfigError,
  createDb,
  createEmailTools,
  createPgRepositories,
  EMBEDDING_DIMENSIONS,
  EmailIndexer,
  GeminiEmbeddings,
  HybridSearch,
  createSystemLogger,
  EncryptedTokenStore,
  EventBus,
  GoogleGatewayProvider,
  GoogleOAuthService,
  MailboxService,
  MailSync,
  openInSystemBrowser,
  OutboxWorker,
  SyncScheduler,
  TasksSync,
  ToolRegistry,
} from '@ai-email/core';

export interface Services {
  config: AppConfig;
  logger: Logger;
  db: Db;
  repos: Repositories;
  events: EventBus;
  auth: GoogleOAuthService;
  scheduler: SyncScheduler;
  tools: ToolRegistry;
  /** Embedding model of the semantic index, when indexing is on. */
  indexModel?: string;
  /** The assistant, when an LLM is configured. */
  chat?: { agent: ChatAgent; files: ChatFileStore; memory: MemoryService };
  /** Mail automations, when an LLM is configured. */
  workflows?: WorkflowEngine;
  /** Stop background sync and close the database pool. */
  close(): Promise<void>;
}

export function createServices(config: AppConfig): Services {
  if (!config.appSecretKey)
    throw new ConfigError(
      'APP_SECRET_KEY is required to store Google tokens (`openssl rand -base64 32`).',
    );
  const cipher = new AesGcmSecretCipher(config.appSecretKey);
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
  const embeddings = config.geminiApiKey
    ? new GeminiEmbeddings({
        apiKey: config.geminiApiKey,
        model: config.llm.embedModel,
        dimensions: EMBEDDING_DIMENSIONS,
      })
    : undefined;
  const indexer =
    embeddings && config.rag.indexing
      ? new EmailIndexer({ repos, embeddings, events, logger })
      : undefined;
  const scheduler = new SyncScheduler({
    repos,
    auth,
    mailSync,
    tasksSync,
    outbox,
    events,
    logger,
    mailIntervalMs: config.sync.pollSeconds * 1000,
    indexer,
  });
  const mailbox = new MailboxService(repos, events);
  const search = new HybridSearch({ repos, embeddings, logger });
  const tools = new ToolRegistry(actions).register(
    ...createEmailTools({ repos, mailbox, gateways, events, search }),
  );

  let chat: Services['chat'];
  let workflows: WorkflowEngine | undefined;
  if (config.geminiApiKey) {
    const llm = new GeminiProvider({ apiKey: config.geminiApiKey, model: config.llm.model });
    workflows = new WorkflowEngine({
      repos,
      llm,
      embeddings,
      tools,
      events,
      logger,
      actions,
      documents: new GoogleDriveDocumentSink(gateways),
    });
    tools.register(...createWorkflowTools(workflows, repos));
    // Persistent workflows decide every new email as sync brings it in.
    const engine = workflows;
    events.on(
      'message.added',
      ({ accountId, messageIds }) => void engine.enqueue(accountId, messageIds),
    );
    const memory = new MemoryService({ repos, llm, embeddings, actions, logger });
    const files = new ChatFileStore(repos.chatFiles, join(config.dataDir, 'chat-files'));
    chat = { agent: new ChatAgent({ repos, llm, tools, files, memory, logger }), files, memory };
  }

  return {
    config,
    logger,
    db,
    repos,
    events,
    auth,
    scheduler,
    tools,
    indexModel: indexer?.model,
    chat,
    workflows,
    async close() {
      await scheduler.stop();
      await chat?.agent.idle(); // let memory updates finish
      await workflows?.idle(); // and workflow runs on new mail
      await db.destroy();
    },
  };
}
