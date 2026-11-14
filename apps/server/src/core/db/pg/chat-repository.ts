import { randomUUID } from 'node:crypto';
import { type Selectable, sql } from 'kysely';
import type {
  ChatFile,
  ChatMessage,
  ChatSession,
  MemoryCategory,
  MemoryItem,
  StoredPart,
  ToolRun,
  ToolRunStatus,
} from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { ChatFileRepository, ChatRepository, MemoryRepository } from '../repositories.js';
import type {
  ChatFilesTable,
  ChatMessagesTable,
  ChatSessionsTable,
  MemoryItemsTable,
  StoredToolRun,
} from '../schema.js';
import { clamp } from './util.js';

const toVector = (values: number[]) => `[${values.join(',')}]`;

function toSession(row: Selectable<ChatSessionsTable>): ChatSession {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    summary: row.summary ?? undefined,
    summarizedThrough: row.summarized_through ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** chat_messages columns that make a ChatMessage (tool_runs is read separately). */
const MESSAGE_COLUMNS = ['id', 'session_id', 'role', 'parts', 'created_at'] as const;

function toMessage(
  row: Pick<Selectable<ChatMessagesTable>, (typeof MESSAGE_COLUMNS)[number]>,
): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    parts: row.parts,
    createdAt: row.created_at,
  };
}

function toRun(sessionId: string, messageId: string, run: StoredToolRun): ToolRun {
  return {
    id: run.id,
    sessionId,
    messageId,
    position: run.position,
    callId: run.callId,
    tool: run.tool,
    input: run.input,
    status: run.status,
    result: run.result ?? undefined,
    createdAt: new Date(run.createdAt),
    resolvedAt: run.resolvedAt ? new Date(run.resolvedAt) : undefined,
  };
}

/** `chat_messages m` holds tool run `id` (GIN-indexed containment). */
const holdsRun = (id: string) => sql<boolean>`m.tool_runs @> ${JSON.stringify([{ id }])}::jsonb`;

export class PgChatRepository implements ChatRepository {
  constructor(private readonly db: Db) {}

  async createSession(accountId: string, title?: string) {
    const row = await this.db
      .insertInto('chat_sessions')
      .values({ account_id: accountId, ...(title && { title }) })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSession(row);
  }

  async listSessions(accountId: string) {
    const rows = await this.db
      .selectFrom('chat_sessions')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('updated_at', 'desc')
      .execute();
    return rows.map(toSession);
  }

  async getSession(id: string) {
    const row = await this.db
      .selectFrom('chat_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toSession(row);
  }

  async updateSession(
    id: string,
    patch: { title?: string; summary?: string; summarizedThrough?: string },
  ) {
    await this.db
      .updateTable('chat_sessions')
      .set({
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.summary !== undefined && { summary: patch.summary }),
        ...(patch.summarizedThrough !== undefined && {
          summarized_through: patch.summarizedThrough,
        }),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async deleteSession(id: string) {
    await this.db.deleteFrom('chat_sessions').where('id', '=', id).execute();
  }

  async appendMessage(sessionId: string, role: 'user' | 'model', parts: StoredPart[]) {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('chat_messages')
        .values({ session_id: sessionId, role, parts: JSON.stringify(parts) })
        .returning(MESSAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('chat_sessions')
        .set({ updated_at: sql`now()` })
        .where('id', '=', sessionId)
        .execute();
      return toMessage(row);
    });
  }

  async listMessages(sessionId: string, options: { afterId?: string } = {}) {
    let q = this.db
      .selectFrom('chat_messages')
      .select(MESSAGE_COLUMNS)
      .where('session_id', '=', sessionId);
    if (options.afterId) q = q.where('id', '>', options.afterId);
    return (await q.orderBy('id').execute()).map(toMessage);
  }

  async createToolRuns(
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
  ) {
    if (runs.length === 0) return [];
    const createdAt = new Date().toISOString();
    const stored: StoredToolRun[] = runs
      .map((r) => ({
        id: randomUUID(),
        position: r.position,
        ...(r.callId !== undefined && { callId: r.callId }),
        tool: r.tool,
        input: r.input,
        status: r.status,
        ...(r.result !== undefined && { result: r.result }),
        createdAt,
        ...(r.status !== 'awaiting_approval' && { resolvedAt: createdAt }),
      }))
      .sort((a, b) => a.position - b.position);
    const updated = await this.db
      .updateTable('chat_messages')
      .set({ tool_runs: sql`tool_runs || ${JSON.stringify(stored)}::jsonb` })
      .where('id', '=', messageId)
      .where('session_id', '=', sessionId)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new Error(`Chat message ${messageId} not found in session ${sessionId}`);
    return stored.map((r) => toRun(sessionId, messageId, r));
  }

  async getToolRun(id: string) {
    const row = await this.db
      .selectFrom('chat_messages as m')
      .select(['m.id', 'm.session_id', 'm.tool_runs'])
      .where(holdsRun(id))
      .executeTakeFirst();
    const run = row?.tool_runs.find((r) => r.id === id);
    return row && run && toRun(row.session_id, row.id, run);
  }

  async listToolRuns(messageId: string) {
    const row = await this.db
      .selectFrom('chat_messages')
      .select(['id', 'session_id', 'tool_runs'])
      .where('id', '=', messageId)
      .executeTakeFirst();
    if (!row) return [];
    return row.tool_runs
      .map((r) => toRun(row.session_id, row.id, r))
      .sort((a, b) => a.position - b.position);
  }

  async resolveToolRun(
    id: string,
    outcome: { status: Exclude<ToolRunStatus, 'awaiting_approval'>; result: unknown },
  ) {
    // One statement, so concurrent resolutions of runs in the same message can't lose each other.
    const patch = JSON.stringify({ status: outcome.status, result: outcome.result ?? null });
    await this.db
      .updateTable('chat_messages as m')
      .set({
        tool_runs: sql`(
          select jsonb_agg(
            case when r ->> 'id' = ${id}
              then r || ${patch}::jsonb || jsonb_build_object('resolvedAt', now())
              else r end
            order by n)
          from jsonb_array_elements(m.tool_runs) with ordinality as e (r, n)
        )`,
      })
      .where(holdsRun(id))
      .execute();
  }

  async awaitingToolRuns(sessionId: string) {
    const rows = await this.db
      .selectFrom('chat_messages as m')
      .select(['m.id', 'm.session_id', 'm.tool_runs'])
      .where('m.session_id', '=', sessionId)
      .where(sql<boolean>`m.tool_runs @> '[{"status": "awaiting_approval"}]'::jsonb`)
      .orderBy('m.id')
      .execute();
    return rows.flatMap((row) =>
      row.tool_runs
        .filter((r) => r.status === 'awaiting_approval')
        .sort((a, b) => a.position - b.position)
        .map((r) => toRun(row.session_id, row.id, r)),
    );
  }
}

function toMemory(row: Selectable<MemoryItemsTable>): MemoryItem {
  return {
    id: row.id,
    accountId: row.account_id,
    content: row.content,
    category: row.category as MemoryCategory,
    sourceSessionId: row.source_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MEMORY_COLUMNS = [
  'id',
  'account_id',
  'content',
  'category',
  'source_session_id',
  'created_at',
  'updated_at',
] as const;

export class PgMemoryRepository implements MemoryRepository {
  constructor(private readonly db: Db) {}

  async list(accountId: string) {
    const rows = await this.db
      .selectFrom('memory_items')
      .select(MEMORY_COLUMNS)
      .where('account_id', '=', accountId)
      .orderBy('updated_at', 'desc')
      .execute();
    return rows.map((r) => toMemory({ ...r, embedding: null }));
  }

  async get(id: string) {
    const row = await this.db
      .selectFrom('memory_items')
      .select(MEMORY_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toMemory({ ...row, embedding: null });
  }

  async add(
    accountId: string,
    item: {
      content: string;
      category: MemoryCategory;
      sourceSessionId?: string;
      embedding?: number[];
    },
  ) {
    const row = await this.db
      .insertInto('memory_items')
      .values({
        account_id: accountId,
        content: item.content,
        category: item.category,
        source_session_id: item.sourceSessionId ?? null,
        embedding: item.embedding ? toVector(item.embedding) : null,
      })
      .returning(MEMORY_COLUMNS)
      .executeTakeFirstOrThrow();
    return toMemory({ ...row, embedding: null });
  }

  async update(id: string, patch: { content: string; embedding?: number[] }) {
    const row = await this.db
      .updateTable('memory_items')
      .set({
        content: patch.content,
        // A stale vector would mislead retrieval; clear it unless a new one is given.
        embedding: patch.embedding ? toVector(patch.embedding) : null,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .returning(MEMORY_COLUMNS)
      .executeTakeFirst();
    return row && toMemory({ ...row, embedding: null });
  }

  async delete(id: string) {
    await this.db.deleteFrom('memory_items').where('id', '=', id).execute();
  }

  async search(accountId: string, embedding: number[], limit: number) {
    const rows = await this.db
      .selectFrom('memory_items')
      .select(MEMORY_COLUMNS)
      .where('account_id', '=', accountId)
      .where('embedding', 'is not', null)
      .orderBy(sql`embedding <=> ${toVector(embedding)}::vector`)
      .limit(clamp(limit, 1, 100))
      .execute();
    return rows.map((r) => toMemory({ ...r, embedding: null }));
  }
}

function toFile(row: Selectable<ChatFilesTable>): ChatFile {
  return {
    id: row.id,
    accountId: row.account_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    storagePath: row.storage_path,
    extractedText: row.extracted_text ?? undefined,
    createdAt: row.created_at,
  };
}

export class PgChatFileRepository implements ChatFileRepository {
  constructor(private readonly db: Db) {}

  async create(file: Omit<ChatFile, 'id' | 'createdAt'>) {
    const row = await this.db
      .insertInto('chat_files')
      .values({
        account_id: file.accountId,
        filename: file.filename,
        mime_type: file.mimeType,
        size: file.size,
        storage_path: file.storagePath,
        extracted_text: file.extractedText ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toFile(row);
  }

  async get(id: string) {
    const row = await this.db
      .selectFrom('chat_files')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toFile(row);
  }

  async listForAccount(accountId: string) {
    const rows = await this.db
      .selectFrom('chat_files')
      .selectAll()
      .where('account_id', '=', accountId)
      .execute();
    return rows.map(toFile);
  }
}
