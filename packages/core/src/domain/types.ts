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

/** A chat message part as stored: files are referenced by id, not inlined. */
export type StoredPart =
  | { type: 'text'; text: string; signature?: string }
  | { type: 'file_ref'; fileId: string; name: string; mimeType: string }
  | {
      type: 'tool_call';
      id?: string;
      name: string;
      args: Record<string, unknown>;
      signature?: string;
    }
  | { type: 'tool_result'; id?: string; name: string; result: unknown; isError?: boolean };

export interface ChatSession {
  id: string;
  accountId: string;
  title: string;
  /** Rolling summary of messages up to summarizedThrough. */
  summary?: string;
  summarizedThrough?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  /** Monotonic; also orders the conversation. */
  id: string;
  sessionId: string;
  role: 'user' | 'model';
  parts: StoredPart[];
  createdAt: Date;
}

export type ToolRunStatus = 'awaiting_approval' | 'done' | 'error' | 'rejected';

/** One tool call made by the assistant in a model message. */
export interface ToolRun {
  id: string;
  sessionId: string;
  messageId: string;
  /** Index of the call within the model message. */
  position: number;
  callId?: string;
  tool: string;
  input: Record<string, unknown>;
  status: ToolRunStatus;
  result?: unknown;
  createdAt: Date;
  resolvedAt?: Date;
}

export type MemoryCategory = 'preference' | 'identity' | 'relationship' | 'rule' | 'other';

/** A long-lived fact about the user, shared by every chat session of the account. */
export interface MemoryItem {
  id: string;
  accountId: string;
  content: string;
  category: MemoryCategory;
  sourceSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatFile {
  id: string;
  accountId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Absolute path of the stored bytes. */
  storagePath: string;
  /** Text extracted for formats the model can't read directly (docx, xlsx, txt, ...). */
  extractedText?: string;
  createdAt: Date;
}

export type WorkflowType = 'label' | 'todo' | 'archive' | 'star_read';
export type WorkflowMode = 'persistent' | 'one_shot';
export type WorkflowStatus =
  'previewing' | 'awaiting_approval' | 'active' | 'paused' | 'completed' | 'failed';

/** What a workflow does to matching mail. */
export interface WorkflowAction {
  /** label: the label to apply (created if missing). */
  labelName?: string;
  /** todo: title of each todo (default: the email subject). */
  todoTitle?: string;
  /** star_read */
  star?: boolean;
  markRead?: boolean;
}

export interface Workflow {
  id: string;
  accountId: string;
  name: string;
  type: WorkflowType;
  mode: WorkflowMode;
  /** The user's request, verbatim. */
  instruction: string;
  /** Which emails match (and which don't), as written for the classifier. */
  criteria: string;
  keywords: string[];
  /** Only consider mail whose sender contains this. */
  senderFilter?: string;
  /** Only consider mail received on/after this. */
  since?: Date;
  action: WorkflowAction;
  status: WorkflowStatus;
  error?: string;
  sessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DecisionStatus = 'pending' | 'applied' | 'skipped' | 'undone' | 'failed';

export interface WorkflowDecision {
  workflowId: string;
  messageId: string;
  phase: 'backfill' | 'incremental';
  match: boolean;
  confidence: number;
  reason: string;
  /** pending = matched, waiting for approval; skipped = not a match (or below the threshold). */
  status: DecisionStatus;
  error?: string;
  decidedAt: Date;
  appliedAt?: Date;
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
