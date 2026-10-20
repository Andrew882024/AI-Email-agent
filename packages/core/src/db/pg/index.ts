import type { Db } from '../connection.js';
import type { Repositories } from '../repositories.js';
import { PgAccountRepository } from './account-repository.js';
import { PgChatFileRepository, PgChatRepository, PgMemoryRepository } from './chat-repository.js';
import { PgActionLogRepository } from './action-log-repository.js';
import { PgLabelRepository } from './label-repository.js';
import { PgMessageRepository } from './message-repository.js';
import { PgOAuthTokenRepository } from './oauth-token-repository.js';
import { PgOutboxRepository } from './outbox-repository.js';
import { PgSyncStateRepository } from './sync-state-repository.js';
import { PgVectorStore } from './vector-store.js';
import { PgTodoRepository } from './todo-repository.js';

/** Embedding size; fixed by migration 0003's vector column. */
export const EMBEDDING_DIMENSIONS = 1536;

export function createPgRepositories(db: Db): Repositories {
  return {
    accounts: new PgAccountRepository(db),
    oauthTokens: new PgOAuthTokenRepository(db),
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
  };
}
