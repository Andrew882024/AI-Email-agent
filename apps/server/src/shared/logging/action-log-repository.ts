import type { Selectable } from 'kysely';
import type { ActionLogEntry, ActionStatus, Actor, Page } from '../types.js';
import type { Db } from '../db/connection.js';
import type { ActionLogsTable } from '../db/schema.js';
import { clamp, decodeCursor, encodeCursor } from '../db/util.js';

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

function toEntry(row: Selectable<ActionLogsTable>): ActionLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    accountId: row.account_id ?? undefined,
    actor: row.actor as Actor,
    action: row.action,
    targetIds: row.target_ids,
    params: row.params ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    durationMs: row.duration_ms ?? undefined,
  };
}

export class PgActionLogRepository implements ActionLogRepository {
  constructor(private readonly db: Db) {}

  async insert(entry: NewActionLog) {
    const row = await this.db
      .insertInto('action_logs')
      .values({
        account_id: entry.accountId ?? null,
        actor: entry.actor,
        action: entry.action,
        target_ids: entry.targetIds ?? [],
        params: entry.params === undefined ? null : JSON.stringify(entry.params),
        status: entry.status,
        error: entry.error ?? null,
        duration_ms: entry.durationMs ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntry(row);
  }

  async query(filter: ActionLogQuery) {
    const limit = clamp(filter.limit, 1, 500);
    let q = this.db.selectFrom('action_logs').selectAll();
    if (filter.accountId) q = q.where('account_id', '=', filter.accountId);
    if (filter.actor) q = q.where('actor', '=', filter.actor);
    if (filter.action) q = q.where('action', '=', filter.action);
    if (filter.status) q = q.where('status', '=', filter.status);
    if (filter.since) q = q.where('ts', '>=', filter.since);
    if (filter.until) q = q.where('ts', '<', filter.until);
    if (filter.cursor) {
      const [beforeId] = decodeCursor(filter.cursor, 1) as [string];
      q = q.where('id', '<', beforeId);
    }
    const rows = await q
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toEntry),
      ...(rows.length > limit && last && { nextCursor: encodeCursor([last.id]) }),
    };
  }

  async deleteForAccount(accountId: string) {
    await this.db.deleteFrom('action_logs').where('account_id', '=', accountId).execute();
  }
}
