// Storage contracts of the mailbox module's tables (messages, labels, todos, outbox_ops).
import type {
  Label,
  Message,
  MessageSummary,
  MessageUpsert,
  OutboxOp,
  Page,
  ThreadSummary,
  Todo,
  TodoStatus,
} from '../shared/types.js';

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
  /** Sender address or name contains this (case-insensitive). */
  from?: string;
  receivedAfter?: Date;
  receivedBefore?: Date;
  /** Clamped to 1..200. */
  limit: number;
  cursor?: string;
}

/** Filters without paging, for ranked searches. */
export type MessageFilter = Omit<MessageListQuery, 'limit' | 'cursor'>;

/** A ranked search hit: higher score = more relevant. */
export interface SearchHit {
  messageId: string;
  score: number;
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
  /**
   * Conversations with at least one message matching the query, newest (matching) first. Each
   * summary aggregates the whole conversation.
   */
  listThreads(accountId: string, query: MessageListQuery): Promise<Page<ThreadSummary>>;
  /** Same semantics as Gmail batchModify. Unknown message ids are ignored. */
  modifyLabels(
    accountId: string,
    messageIds: string[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<void>;
  /** Delete messages (their labels, attachments and embeddings go with them). */
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
  /** Keyword matches ranked by full-text relevance (substring-only matches rank by recency). */
  keywordSearch(
    accountId: string,
    text: string,
    filter: MessageFilter,
    limit: number,
  ): Promise<SearchHit[]>;
}

/** Message embeddings for semantic search ("one chunk per email"). */
export interface VectorStore {
  readonly dimensions: number;
  /**
   * Messages needing (re-)embedding, newest first: no embedding yet, embedded with another
   * model, or changed since. Includes the stored content hash so unchanged content can be skipped.
   */
  stale(
    accountId: string,
    model: string,
    limit: number,
  ): Promise<{ messageId: string; contentHash?: string }[]>;
  upsert(
    accountId: string,
    items: { messageId: string; model: string; contentHash: string; embedding: number[] }[],
  ): Promise<void>;
  /** Mark embeddings current without re-embedding (the message changed but its text didn't). */
  touch(accountId: string, messageIds: string[]): Promise<void>;
  /** Nearest messages by cosine similarity (score in [-1, 1]), honoring the filter. */
  search(
    accountId: string,
    embedding: number[],
    filter: MessageFilter,
    limit: number,
  ): Promise<SearchHit[]>;
  stats(accountId: string, model: string): Promise<{ indexed: number; total: number }>;
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
