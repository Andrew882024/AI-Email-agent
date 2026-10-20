// Kysely table types. Mirrors migrations/; only db/ code imports this.
import type { ColumnType, Generated } from 'kysely';
import type { EmailAddress, StoredPart } from '../domain/types.js';

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
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OAuthTokensTable {
  account_id: string;
  encrypted_refresh_token: string;
  scopes: string[];
  updated_at: Generated<Date>;
}

export interface LabelsTable {
  account_id: string;
  id: string;
  name: string;
  type: 'system' | 'user';
  color_background: string | null;
  color_text: string | null;
}

export interface ThreadsTable {
  account_id: string;
  id: string;
  snippet: string | null;
  last_message_at: Date | null;
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
  fts: ColumnType<string, never, never>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MessageLabelsTable {
  account_id: string;
  message_id: string;
  label_id: string;
}

export interface AttachmentsTable {
  account_id: string;
  message_id: string;
  part_id: string;
  attachment_id: string | null;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
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

export interface SyncStateTable {
  account_id: string;
  full_sync_started_at: Date | null;
  full_sync_history_id: string | null;
  full_sync_page_token: string | null;
  full_sync_window_start: Date | null;
  full_sync_count: Generated<number>;
  tasks_synced_at: Date | null;
  updated_at: Generated<Date>;
}

export interface EmailEmbeddingsTable {
  account_id: string;
  message_id: string;
  model: string;
  content_hash: string;
  /** pgvector literal ('[0.1,0.2,...]') on write; not selected back. */
  embedding: ColumnType<string, string, string>;
  embedded_at: Generated<Date>;
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
  created_at: Generated<Date>;
}

export interface ToolRunsTable {
  id: Generated<string>;
  session_id: string;
  message_id: string;
  position: number;
  call_id: string | null;
  tool: string;
  input: Json<Record<string, unknown>>;
  status: 'awaiting_approval' | 'done' | 'error' | 'rejected';
  result: Json<unknown> | null;
  created_at: Generated<Date>;
  resolved_at: Date | null;
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

export interface Database {
  accounts: AccountsTable;
  oauth_tokens: OAuthTokensTable;
  labels: LabelsTable;
  threads: ThreadsTable;
  messages: MessagesTable;
  message_labels: MessageLabelsTable;
  attachments: AttachmentsTable;
  todos: TodosTable;
  outbox_ops: OutboxOpsTable;
  action_logs: ActionLogsTable;
  sync_state: SyncStateTable;
  email_embeddings: EmailEmbeddingsTable;
  chat_sessions: ChatSessionsTable;
  chat_messages: ChatMessagesTable;
  tool_runs: ToolRunsTable;
  memory_items: MemoryItemsTable;
  chat_files: ChatFilesTable;
}
