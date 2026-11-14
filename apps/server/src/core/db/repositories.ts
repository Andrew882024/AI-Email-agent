// Storage-agnostic repository contracts. Business code depends only on these; db/pg/ implements
// them for Postgres. A MySQL port would add db/mysql/ with the same interfaces.
import type {
  AccountRepository,
  OAuthTokenRepository,
  SessionRepository,
} from '../../auth/repositories.js';
import type {
  LabelRepository,
  MessageRepository,
  OutboxRepository,
  TodoRepository,
  VectorStore,
} from '../../mailbox/repositories.js';
import type { SyncStateRepository } from '../../sync/repositories.js';
import type { ActionLogRepository } from '../../shared/logging/action-log-repository.js';
import type {
  ChatFileRepository,
  ChatRepository,
  MemoryRepository,
  WorkflowRepository,
} from '../../agent/repositories.js';

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
