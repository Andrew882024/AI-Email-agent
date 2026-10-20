// Storage-agnostic repository contracts. Business code depends only on these; db/pg/ implements
// them for Postgres. A MySQL port would add db/mysql/ with the same interfaces.
import type {
  Account,
  ActionLogEntry,
  ActionStatus,
  Actor,
  Label,
  Message,
  MessageSummary,
  MessageUpsert,
  OutboxOp,
  Page,
  FullSyncCheckpoint,
  SyncState,
  Todo,
  TodoStatus,
} from '../domain/types.js';

export interface AccountRepository {
  /** Insert, or update email/displayName of the account with the same googleSub. */
  upsert(input: { email: string; googleSub: string; displayName?: string }): Promise<Account>;
  getById(id: string): Promise<Account | undefined>;
  list(): Promise<Account[]>;
  updateSyncState(id: string, state: { historyId?: string; lastFullSyncAt?: Date }): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface StoredOAuthToken {
  accountId: string;
  /** Ciphertext produced by a SecretCipher; this layer never sees the plaintext token. */
  encryptedRefreshToken: string;
  scopes: string[];
  updatedAt: Date;
}

export interface OAuthTokenRepository {
  get(accountId: string): Promise<StoredOAuthToken | undefined>;
  /** Insert or replace the account's token. */
  save(
    accountId: string,
    token: { encryptedRefreshToken: string; scopes: string[] },
  ): Promise<void>;
  delete(accountId: string): Promise<void>;
}

export interface LabelRepository {
  list(accountId: string): Promise<Label[]>;
  get(accountId: string, id: string): Promise<Label | undefined>;
  /** Case-insensitive, like Gmail. */
  findByName(accountId: string, name: string): Promise<Label | undefined>;
  upsert(accountId: string, labels: Label[]): Promise<void>;
  /** Make the stored set exactly `labels`; labels not in it are deleted and detached from messages. */
  replaceAll(accountId: string, labels: Label[]): Promise<void>;
  /** Delete the label and detach it from all messages. */
  delete(accountId: string, id: string): Promise<void>;
}

export interface MessageListQuery {
  /** Message must carry every one of these labels (e.g. ['INBOX'], ['STARRED'], ['UNREAD']). */
  labelIds?: string[];
  /** Message must carry none of these (e.g. ['TRASH', 'SPAM'] for All Mail). */
  excludeLabelIds?: string[];
  /** Keyword search over subject, sender and body. */
  search?: string;
  /** Clamped to 1..200. */
  limit: number;
  cursor?: string;
}

export interface LabelCounts {
  total: number;
  unread: number;
}

export interface MessageRepository {
  /** Insert or fully replace messages, including their labels and attachments. */
  upsertMany(accountId: string, messages: MessageUpsert[]): Promise<void>;
  getById(accountId: string, id: string): Promise<Message | undefined>;
  getByIds(accountId: string, ids: string[]): Promise<Message[]>;
  /** Messages of a thread, oldest first. */
  getThread(accountId: string, threadId: string): Promise<Message[]>;
  /** Newest first. */
  list(accountId: string, query: MessageListQuery): Promise<Page<MessageSummary>>;
  /** Same semantics as Gmail batchModify. Unknown message ids are ignored. */
  modifyLabels(
    accountId: string,
    messageIds: string[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  /** Delete messages; threads left empty are deleted too. */
  deleteMany(accountId: string, ids: string[]): Promise<void>;
  /**
   * After a full resync: delete messages not refreshed since `updatedBefore` (gone from Gmail),
   * limited to those received on/after `receivedSince` when given. Returns the deleted ids.
   */
  sweepStale(
    accountId: string,
    options: { updatedBefore: Date; receivedSince?: Date },
  ): Promise<string[]>;
  countByLabel(accountId: string): Promise<Record<string, LabelCounts>>;
}

export interface NewTodo {
  accountId: string;
  messageId?: string;
  googleTaskId?: string;
  tasklistId?: string;
  title: string;
  status?: TodoStatus;
  due?: Date;
}

export interface TodoPatch {
  googleTaskId?: string;
  tasklistId?: string;
  title?: string;
  status?: TodoStatus;
  /** null clears. */
  due?: Date | null;
  /** null clears. */
  completedAt?: Date | null;
}

export interface TodoRepository {
  create(input: NewTodo): Promise<Todo>;
  getById(id: string): Promise<Todo | undefined>;
  getByGoogleTaskId(accountId: string, googleTaskId: string): Promise<Todo | undefined>;
  list(accountId: string, filter?: { status?: TodoStatus; messageId?: string }): Promise<Todo[]>;
  update(id: string, patch: TodoPatch): Promise<Todo | undefined>;
  delete(id: string): Promise<void>;
}

export interface OutboxRepository {
  enqueue(accountId: string, op: string, payload: unknown): Promise<OutboxOp>;
  /**
   * Claim the account's oldest unfinished op if it is pending and due: mark it in_progress and bump
   * attempts. Strict FIFO per account: while the oldest op waits for a retry, later ops wait too,
   * so changes reach Google in the order they were made.
   */
  claimNext(accountId: string): Promise<OutboxOp | undefined>;
  /** Pending and in-progress ops of the account, oldest first. */
  listActive(accountId: string): Promise<OutboxOp[]>;
  markDone(id: string): Promise<void>;
  /**
   * Back to pending, retried after `delayMs`. Relative, so the due time is computed on the
   * database clock that claimNext() compares against.
   */
  markRetry(id: string, error: string, delayMs: number): Promise<void>;
  /** Give up permanently. */
  markFailed(id: string, error: string): Promise<void>;
  /** Return ops stuck in_progress (e.g. after a crash) to pending. Returns how many. */
  requeueInProgress(): Promise<number>;
}

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
}

export interface SyncStateRepository {
  get(accountId: string): Promise<SyncState>;
  /**
   * Start a full-sync checkpoint. startedAt comes from the database clock, the same clock that
   * stamps messages.updated_at, so the end-of-sync sweep can't be fooled by host/DB clock skew.
   */
  beginFullSync(
    accountId: string,
    input: { historyId: string; windowStart?: Date },
  ): Promise<FullSyncCheckpoint>;
  /** `fullSync: null` clears the checkpoint (full sync finished). */
  update(
    accountId: string,
    patch: { fullSync?: FullSyncCheckpoint | null; tasksSyncedAt?: Date },
  ): Promise<void>;
}

export interface Repositories {
  accounts: AccountRepository;
  oauthTokens: OAuthTokenRepository;
  labels: LabelRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  outbox: OutboxRepository;
  actionLogs: ActionLogRepository;
  syncState: SyncStateRepository;
}
