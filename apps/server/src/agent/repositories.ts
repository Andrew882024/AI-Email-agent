// Storage contracts of the agent module's tables (chats, memory, uploads, workflows).
import type {
  ChatFile,
  ChatMessage,
  ChatSession,
  MemoryCategory,
  MemoryItem,
  StoredPart,
  ToolRun,
  ToolRunStatus,
  DecisionStatus,
  Workflow,
  WorkflowAction,
  WorkflowDecision,
  WorkflowMode,
  WorkflowStatus,
  WorkflowType,
} from '../shared/types.js';
import type { AccountRepository } from '../auth/index.js';
import type { LabelRepository, MessageRepository, VectorStore } from '../mailbox/index.js';
import type { Kysely } from 'kysely';
import type { Database } from '../shared/db/schema.js';

/** The tables this module owns; its repositories can't query any other table. */
export type AgentDb = Kysely<
  Pick<
    Database,
    | 'chat_sessions'
    | 'chat_messages'
    | 'memory_items'
    | 'chat_files'
    | 'workflows'
    | 'workflow_decisions'
  >
>;

export interface ChatRepository {
  createSession(accountId: string, title?: string): Promise<ChatSession>;
  /** Most recently active first. */
  listSessions(accountId: string): Promise<ChatSession[]>;
  getSession(id: string): Promise<ChatSession | undefined>;
  updateSession(
    id: string,
    patch: { title?: string; summary?: string; summarizedThrough?: string },
  ): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Appends a message and marks the session active. */
  appendMessage(
    sessionId: string,
    role: 'user' | 'model',
    parts: StoredPart[],
  ): Promise<ChatMessage>;
  /** In order; only messages after `afterId` when given. */
  listMessages(sessionId: string, options?: { afterId?: string }): Promise<ChatMessage[]>;
  createToolRuns(
    sessionId: string,
    messageId: string,
    runs: {
      position: number;
      callId?: string;
      tool: string;
      input: Record<string, unknown>;
      status: ToolRunStatus;
      result?: unknown;
    }[],
  ): Promise<ToolRun[]>;
  getToolRun(id: string): Promise<ToolRun | undefined>;
  /** Ordered by position. */
  listToolRuns(messageId: string): Promise<ToolRun[]>;
  resolveToolRun(
    id: string,
    outcome: { status: Exclude<ToolRunStatus, 'awaiting_approval'>; result: unknown },
  ): Promise<void>;
  /** Tool runs of the session still waiting for the user. */
  awaitingToolRuns(sessionId: string): Promise<ToolRun[]>;
}

export interface MemoryRepository {
  /** Most recently updated first. */
  list(accountId: string): Promise<MemoryItem[]>;
  get(id: string): Promise<MemoryItem | undefined>;
  add(
    accountId: string,
    item: {
      content: string;
      category: MemoryCategory;
      sourceSessionId?: string;
      embedding?: number[];
    },
  ): Promise<MemoryItem>;
  update(
    id: string,
    patch: { content: string; embedding?: number[] },
  ): Promise<MemoryItem | undefined>;
  delete(id: string): Promise<void>;
  /** Most similar items first (items without an embedding are skipped). */
  search(accountId: string, embedding: number[], limit: number): Promise<MemoryItem[]>;
}

export interface ChatFileRepository {
  create(file: Omit<ChatFile, 'id' | 'createdAt'>): Promise<ChatFile>;
  get(id: string): Promise<ChatFile | undefined>;
  listForAccount(accountId: string): Promise<ChatFile[]>;
}

export interface NewWorkflow {
  accountId: string;
  name: string;
  type: WorkflowType;
  mode: WorkflowMode;
  instruction: string;
  criteria: string;
  keywords: string[];
  senderFilter?: string;
  since?: Date;
  action: WorkflowAction;
  sessionId?: string;
}

export interface WorkflowRepository {
  create(input: NewWorkflow, status: WorkflowStatus): Promise<Workflow>;
  get(id: string): Promise<Workflow | undefined>;
  /** Newest first. */
  list(accountId: string, filter?: { status?: WorkflowStatus }): Promise<Workflow[]>;
  setStatus(id: string, status: WorkflowStatus, error?: string): Promise<void>;
  setAction(id: string, action: WorkflowAction): Promise<void>;
  setCriteria(id: string, criteria: Pick<Workflow, 'criteria' | 'keywords'>): Promise<void>;
  delete(id: string): Promise<void>;
  /** Insert decisions; messages already decided by this workflow are left alone. */
  recordDecisions(
    workflowId: string,
    accountId: string,
    decisions: {
      messageId: string;
      phase: 'backfill' | 'incremental';
      match: boolean;
      confidence: number;
      reason: string;
      status: DecisionStatus;
      output?: Record<string, string>;
    }[],
  ): Promise<void>;
  /** Of these messages, the ones this workflow already decided. */
  decided(workflowId: string, messageIds: string[]): Promise<Set<string>>;
  decisions(
    workflowId: string,
    filter?: { status?: DecisionStatus; limit?: number },
  ): Promise<WorkflowDecision[]>;
  getDecision(workflowId: string, messageId: string): Promise<WorkflowDecision | undefined>;
  setDecisionStatus(
    workflowId: string,
    messageIds: string[],
    status: DecisionStatus,
    error?: string,
  ): Promise<void>;
  /** Decision counts by status. */
  counts(workflowId: string): Promise<Partial<Record<DecisionStatus, number>>>;
}

/**
 * What agent code may use: its own tables, account lookups, and read-only access to mail. Changes
 * to mail go through MailboxService and the tools, never these repositories.
 */
export interface AgentRepos {
  accounts: Pick<AccountRepository, 'getById'>;
  chats: ChatRepository;
  memory: MemoryRepository;
  chatFiles: ChatFileRepository;
  workflows: WorkflowRepository;
  messages: Pick<MessageRepository, 'getById' | 'getByIds' | 'list' | 'keywordSearch'>;
  labels: Pick<LabelRepository, 'findByName'>;
  vectors: Pick<VectorStore, 'search'>;
}
