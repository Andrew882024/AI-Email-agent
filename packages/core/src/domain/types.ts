// Storage-agnostic domain models. Repositories return these; nothing outside db/ sees row shapes.

/** Who performed an action. Recorded on every action log entry. */
export type Actor = 'user' | 'sync' | `agent:${string}` | `workflow:${string}`;

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface Account {
  id: string;
  email: string;
  googleSub: string;
  displayName?: string;
  /** Gmail historyId of the last applied sync point. */
  historyId?: string;
  lastFullSyncAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Gmail system label ids that message flags are derived from. */
export const SystemLabel = {
  INBOX: 'INBOX',
  UNREAD: 'UNREAD',
  STARRED: 'STARRED',
  SENT: 'SENT',
  DRAFT: 'DRAFT',
  TRASH: 'TRASH',
  SPAM: 'SPAM',
  IMPORTANT: 'IMPORTANT',
} as const;

export type LabelType = 'system' | 'user';

export interface Label {
  id: string;
  name: string;
  type: LabelType;
  color?: { background: string; text: string };
}

export interface Attachment {
  /** MIME part id; stable across fetches (Gmail attachment ids are not). */
  partId: string;
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Set for inline images referenced via cid:. */
  contentId?: string;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  from?: EmailAddress;
  to: EmailAddress[];
  subject: string;
  snippet: string;
  internalDate: Date;
  hasAttachments: boolean;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
}

export interface Message extends MessageSummary {
  historyId?: string;
  /** RFC 5322 Message-ID header, needed for replies. */
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string;
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  bodyText?: string;
  bodyHtml?: string;
  sizeEstimate?: number;
  attachments: Attachment[];
}

/** A conversation as shown in a mail list: aggregated over all of its messages. */
export interface ThreadSummary {
  threadId: string;
  /** Subject of the first message. */
  subject: string;
  /** Snippet of the newest message. */
  snippet: string;
  /** Date of the newest message matching the list's filter (what the list is sorted by). */
  lastMessageAt: Date;
  messageCount: number;
  /** Senders in order of first appearance, deduplicated. */
  participants: EmailAddress[];
  /** Union of the messages' labels. */
  labelIds: string[];
  /** Every message is read. */
  isRead: boolean;
  /** Any message is starred. */
  isStarred: boolean;
  /** Any message is in the inbox. */
  inInbox: boolean;
  hasAttachments: boolean;
  /** Oldest first; bulk actions on a thread apply to all of them. */
  messageIds: string[];
}

/** What sync writes. Flags (isRead, ...) are derived from labelIds, never stored separately. */
export type MessageUpsert = Omit<Message, 'isRead' | 'isStarred' | 'inInbox'>;

export type TodoStatus = 'needsAction' | 'completed';

/** Local link between a message and the Google Task created for it. */
export interface Todo {
  id: string;
  accountId: string;
  messageId?: string;
  /** Unset until the outbox worker has created the Google Task. */
  googleTaskId?: string;
  tasklistId?: string;
  title: string;
  status: TodoStatus;
  due?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OutboxStatus = 'pending' | 'in_progress' | 'done' | 'failed';

/** A local change waiting to be pushed to Gmail / Google Tasks. */
export interface OutboxOp {
  id: string;
  accountId: string;
  op: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Progress of a resumable full sync. */
export interface FullSyncCheckpoint {
  startedAt: Date;
  /** Mailbox historyId captured before listing; incremental sync resumes from here. */
  historyId: string;
  /** Next messages.list page; unset before the first page. */
  pageToken?: string;
  /** Only messages received on/after this are synced; unset = whole mailbox. */
  windowStart?: Date;
  /** Messages stored so far. */
  synced: number;
}

export interface SyncState {
  accountId: string;
  /** Set while a full sync is in progress (also across restarts). */
  fullSync?: FullSyncCheckpoint;
  /** Google Tasks were polled up to this time. */
  tasksSyncedAt?: Date;
}

export type ActionStatus = 'success' | 'error';

export interface ActionLogEntry {
  id: string;
  ts: Date;
  accountId?: string;
  actor: Actor;
  action: string;
  targetIds: string[];
  params?: unknown;
  status: ActionStatus;
  error?: string;
  durationMs?: number;
}

export interface Page<T> {
  items: T[];
  /** Opaque; pass back to fetch the next page. Absent on the last page. */
  nextCursor?: string;
}
