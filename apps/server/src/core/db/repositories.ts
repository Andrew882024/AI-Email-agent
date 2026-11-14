// Storage-agnostic repository contracts. Business code depends only on these; db/pg/ implements
// them for Postgres. A MySQL port would add db/mysql/ with the same interfaces.
import type { ActionLogEntry, ActionStatus, Actor, Page } from '../../shared/types.js';
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
import type {
  ChatFileRepository,
  ChatRepository,
  MemoryRepository,
  WorkflowRepository,
} from '../../agent/repositories.js';

export interface NewActionLog {
  accountId?: string;
  actor: Actor;
  action: string;
  targetIds?: string[];
  params?: unknown;
  status: ActionStatus;
  error?: string;
  durationMs?: number;
}

export interface ActionLogQuery {
  accountId?: string;
  actor?: Actor;
  action?: string;
  status?: ActionStatus;
  since?: Date;
  until?: Date;
  /** Clamped to 1..500. */
  limit: number;
  cursor?: string;
}

export interface ActionLogRepository {
  insert(entry: NewActionLog): Promise<ActionLogEntry>;
  /** Newest first. */
  query(filter: ActionLogQuery): Promise<Page<ActionLogEntry>>;
  /** Forget an account's history (when the user deletes their account). */
  deleteForAccount(accountId: string): Promise<void>;
}

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
