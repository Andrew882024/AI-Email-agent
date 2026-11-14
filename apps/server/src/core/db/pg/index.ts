import type { Db } from '../../../shared/db/connection.js';
import type { Repositories } from '../repositories.js';
import { EMBEDDING_DIMENSIONS } from '../../../shared/db/schema.js';
import { PgAccountRepository } from '../../../auth/account-repository.js';
import {
  PgChatFileRepository,
  PgChatRepository,
  PgMemoryRepository,
} from '../../../agent/chat-repository.js';
import { PgActionLogRepository } from '../../../shared/logging/action-log-repository.js';
import { PgLabelRepository } from '../../../mailbox/label-repository.js';
import { PgMessageRepository } from '../../../mailbox/message-repository.js';
import { PgOAuthTokenRepository } from '../../../auth/oauth-token-repository.js';
import { PgOutboxRepository } from '../../../mailbox/outbox-repository.js';
import { PgSessionRepository } from '../../../auth/session-repository.js';
import { PgSyncStateRepository } from '../../../sync/sync-state-repository.js';
import { PgVectorStore } from '../../../mailbox/vector-store.js';
import { PgWorkflowRepository } from '../../../agent/workflows/workflow-repository.js';
import { PgTodoRepository } from '../../../mailbox/todo-repository.js';

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
