import type { Selectable } from 'kysely';
import type { ActionLogEntry, Actor } from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { ActionLogQuery, ActionLogRepository, NewActionLog } from '../repositories.js';
import type { ActionLogsTable } from '../schema.js';
import { clamp, decodeCursor, encodeCursor } from './util.js';

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
}
