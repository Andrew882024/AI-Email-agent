// Kysely table types. Mirrors migrations/; only db/ code imports this.
import type { ColumnType, Generated } from 'kysely';
import type { Attachment, EmailAddress, StoredPart } from '../domain/types.js';

/** jsonb: parsed on select, written as a JSON string (node-pg would turn JS arrays into PG arrays). */
type Json<T> = ColumnType<T, string, string>;
/** bigint identity: node-pg returns int8 as string. */
type Int8Id = ColumnType<string, never, never>;

export interface AccountsTable {
  id: Generated<string>;
  email: string;
  google_sub: string;
  display_name: string | null;
  history_id: string | null;
  last_full_sync_at: Date | null;
  /** SecretCipher output; null when no Google token is stored. */
  encrypted_refresh_token: string | null;
  oauth_scopes: Generated<string[]>;
  oauth_updated_at: Date | null;
  /** Resumable full-sync checkpoint; non-null while a full sync is in progress. */
  full_sync_started_at: Date | null;
  full_sync_history_id: string | null;
  full_sync_page_token: string | null;
  full_sync_window_start: Date | null;
  full_sync_count: Generated<number>;
  tasks_synced_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SessionsTable {
  /** SHA-256 of the cookie token. */
  id: string;
  account_id: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Date;
}

export interface LabelsTable {
  account_id: string;
  id: string;
  name: string;
  type: 'system' | 'user';
  color_background: string | null;
  color_text: string | null;
}

export interface MessagesTable {
  account_id: string;
  id: string;
  thread_id: string;
  history_id: string | null;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  from_addr: Json<EmailAddress | null> | null;
  to_addrs: Json<EmailAddress[]>;
  cc_addrs: Json<EmailAddress[]>;
  bcc_addrs: Json<EmailAddress[]>;
  reply_to_addrs: Json<EmailAddress[]>;
  subject: string;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  internal_date: Date;
  size_estimate: number | null;
  has_attachments: boolean;
  /** Sorted Gmail label ids, system ones included; read/starred/inbox flags derive from it. */
  label_ids: Generated<string[]>;
  /** Ordered by partId. */
  attachments: ColumnType<Attachment[], string | undefined, string>;
  /** pgvector literal ('[0.1,0.2,...]') on write; not selected back. */
  embedding: ColumnType<string | null, string | null | undefined, string | null>;
  embedding_model: string | null;
  embedding_hash: string | null;
  embedded_at: Date | null;
  fts: ColumnType<string, never, never>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TodosTable {
  id: Generated<string>;
  account_id: string;
  message_id: string | null;
  google_task_id: string | null;
  tasklist_id: string | null;
  title: string;
  status: Generated<'needsAction' | 'completed'>;
  due: Date | null;
  completed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OutboxOpsTable {
  id: Int8Id;
  account_id: string;
  op: string;
  payload: Json<unknown>;
  status: Generated<'pending' | 'in_progress' | 'done' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  next_attempt_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ActionLogsTable {
  id: Int8Id;
  ts: Generated<Date>;
  account_id: string | null;
  actor: string;
  action: string;
  target_ids: Generated<string[]>;
  params: Json<unknown> | null;
  status: 'success' | 'error';
  error: string | null;
  duration_ms: number | null;
}

export interface ChatSessionsTable {
  id: Generated<string>;
  account_id: string;
  title: Generated<string>;
  summary: string | null;
  summarized_through: ColumnType<string | null, string | null, string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ChatMessagesTable {
  id: Int8Id;
  session_id: string;
  role: 'user' | 'model';
  parts: Json<StoredPart[]>;
  /** Tool calls made by this (model) message, ordered by position. */
  tool_runs: ColumnType<StoredToolRun[], string | undefined, string>;
  created_at: Generated<Date>;
}

/** One element of chat_messages.tool_runs. */
export interface StoredToolRun {
  id: string;
  position: number;
  callId?: string;
  tool: string;
  input: Record<string, unknown>;
  status: 'awaiting_approval' | 'done' | 'error' | 'rejected';
  result?: unknown;
  /** ISO timestamps. */
  createdAt: string;
  resolvedAt?: string;
}

export interface MemoryItemsTable {
  id: Generated<string>;
  account_id: string;
  content: string;
  category: string;
  source_session_id: string | null;
  embedding: ColumnType<string | null, string | null, string | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ChatFilesTable {
  id: Generated<string>;
  account_id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  extracted_text: string | null;
  created_at: Generated<Date>;
}

export interface WorkflowsTable {
  id: Generated<string>;
  account_id: string;
  name: string;
  type: 'label' | 'todo' | 'archive' | 'star_read' | 'document';
  mode: 'persistent' | 'one_shot';
  instruction: string;
  criteria: string;
  keywords: Generated<string[]>;
  sender_filter: string | null;
  since: Date | null;
  action: Json<Record<string, unknown>>;
  status: 'previewing' | 'awaiting_approval' | 'active' | 'paused' | 'completed' | 'failed';
  error: string | null;
  session_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WorkflowDecisionsTable {
  workflow_id: string;
  account_id: string;
  message_id: string;
  phase: 'backfill' | 'incremental';
  match: boolean;
  confidence: number;
  reason: Generated<string>;
  status: 'pending' | 'applied' | 'skipped' | 'undone' | 'failed';
  error: string | null;
  output: Json<Record<string, string>> | null;
  decided_at: Generated<Date>;
  applied_at: Date | null;
}

export interface Database {
  accounts: AccountsTable;
  sessions: SessionsTable;
  labels: LabelsTable;
  messages: MessagesTable;
  todos: TodosTable;
  outbox_ops: OutboxOpsTable;
  action_logs: ActionLogsTable;
  chat_sessions: ChatSessionsTable;
  chat_messages: ChatMessagesTable;
  memory_items: MemoryItemsTable;
  chat_files: ChatFilesTable;
  workflows: WorkflowsTable;
  workflow_decisions: WorkflowDecisionsTable;
}
