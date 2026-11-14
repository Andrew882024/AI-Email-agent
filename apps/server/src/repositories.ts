// Composition: every module's repositories, wired to Postgres. Only the app's entry points (server,
// services, CLI) and tests use this; module code declares the narrower contracts it needs
// (MailboxRepos, AgentRepos, ...).
import { PgAccountRepository } from './auth/account-repository.js';
import { PgOAuthTokenRepository } from './auth/oauth-token-repository.js';
import type {
  AccountRepository,
  OAuthTokenRepository,
  SessionRepository,
} from './auth/repositories.js';
import { PgSessionRepository } from './auth/session-repository.js';
import {
  PgChatFileRepository,
  PgChatRepository,
  PgMemoryRepository,
} from './agent/chat-repository.js';
import type {
  ChatFileRepository,
  ChatRepository,
  MemoryRepository,
  WorkflowRepository,
} from './agent/repositories.js';
import { PgWorkflowRepository } from './agent/workflows/workflow-repository.js';
import { PgLabelRepository } from './mailbox/label-repository.js';
import { PgMessageRepository } from './mailbox/message-repository.js';
import { PgOutboxRepository } from './mailbox/outbox-repository.js';
import type {
  LabelRepository,
  MessageRepository,
  OutboxRepository,
  TodoRepository,
  VectorStore,
} from './mailbox/repositories.js';
import { PgTodoRepository } from './mailbox/todo-repository.js';
import { PgVectorStore } from './mailbox/vector-store.js';
import type { Db } from './shared/db/connection.js';
import { EMBEDDING_DIMENSIONS } from './shared/db/schema.js';
import {
  type ActionLogRepository,
  PgActionLogRepository,
} from './shared/logging/action-log-repository.js';
import type { SyncStateRepository } from './sync/repositories.js';
import { PgSyncStateRepository } from './sync/sync-state-repository.js';

export interface Repositories {
  accounts: AccountRepository;
  oauthTokens: OAuthTokenRepository;
  sessions: SessionRepository;
  labels: LabelRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  outbox: OutboxRepository;
  actionLogs: ActionLogRepository;
  syncState: SyncStateRepository;
  vectors: VectorStore;
  chats: ChatRepository;
  memory: MemoryRepository;
  chatFiles: ChatFileRepository;
  workflows: WorkflowRepository;
}

export function createPgRepositories(db: Db): Repositories {
  return {
    accounts: new PgAccountRepository(db),
    oauthTokens: new PgOAuthTokenRepository(db),
    sessions: new PgSessionRepository(db),
    labels: new PgLabelRepository(db),
    messages: new PgMessageRepository(db),
    todos: new PgTodoRepository(db),
    outbox: new PgOutboxRepository(db),
    actionLogs: new PgActionLogRepository(db),
    syncState: new PgSyncStateRepository(db),
    vectors: new PgVectorStore(db, EMBEDDING_DIMENSIONS),
    chats: new PgChatRepository(db),
    memory: new PgMemoryRepository(db),
    chatFiles: new PgChatFileRepository(db),
    workflows: new PgWorkflowRepository(db),
  };
}
