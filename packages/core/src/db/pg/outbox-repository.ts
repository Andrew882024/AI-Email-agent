import { type Selectable, sql } from 'kysely';
import type { OutboxOp } from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { OutboxRepository } from '../repositories.js';
import type { OutboxOpsTable } from '../schema.js';
import { clamp } from './util.js';

function toOp(row: Selectable<OutboxOpsTable>): OutboxOp {
  return {
    id: row.id,
    accountId: row.account_id,
    op: row.op,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Db) {}

  async enqueue(accountId: string, op: string, payload: unknown) {
    const row = await this.db
      .insertInto('outbox_ops')
      .values({ account_id: accountId, op, payload: JSON.stringify(payload) })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toOp(row);
  }

  async claimBatch(limit: number) {
    const due = this.db
      .selectFrom('outbox_ops')
      .select('id')
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', sql<Date>`now()`)
      .orderBy('id')
      .limit(clamp(limit, 1, 1000))
      .forUpdate()
      .skipLocked();
    const rows = await this.db
      .updateTable('outbox_ops')
      .set((eb) => ({
        status: 'in_progress',
        attempts: eb('attempts', '+', 1),
        updated_at: sql`now()`,
      }))
      .where('id', 'in', due)
      .returningAll()
      .execute();
    // RETURNING order is unspecified; ids are monotonic so this restores FIFO.
    return rows.map(toOp).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async markDone(id: string) {
    await this.db
      .updateTable('outbox_ops')
      .set({ status: 'done', last_error: null, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async markRetry(id: string, error: string, nextAttemptAt: Date) {
    await this.db
      .updateTable('outbox_ops')
      .set({
        status: 'pending',
        last_error: error,
        next_attempt_at: nextAttemptAt,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async markFailed(id: string, error: string) {
    await this.db
      .updateTable('outbox_ops')
      .set({ status: 'failed', last_error: error, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async requeueInProgress() {
    const result = await this.db
      .updateTable('outbox_ops')
      .set({ status: 'pending', updated_at: sql`now()` })
      .where('status', '=', 'in_progress')
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
