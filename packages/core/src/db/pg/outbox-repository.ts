import { type Selectable, sql } from 'kysely';
import type { OutboxOp } from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { OutboxRepository } from '../repositories.js';
import type { OutboxOpsTable } from '../schema.js';

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

  async claimNext(accountId: string) {
    // FOR UPDATE (not SKIP LOCKED): a locked head must block, never be skipped.
    const head = this.db
      .selectFrom('outbox_ops')
      .select('id')
      .where('account_id', '=', accountId)
      .where('status', 'in', ['pending', 'in_progress'])
      .orderBy('id')
      .limit(1)
      .forUpdate();
    const row = await this.db
      .updateTable('outbox_ops')
      .set((eb) => ({
        status: 'in_progress',
        attempts: eb('attempts', '+', 1),
        updated_at: sql`now()`,
      }))
      .where('id', '=', head)
      .where('status', '=', 'pending')
      .where('next_attempt_at', '<=', sql<Date>`now()`)
      .returningAll()
      .executeTakeFirst();
    return row && toOp(row);
  }

  async listActive(accountId: string) {
    const rows = await this.db
      .selectFrom('outbox_ops')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('status', 'in', ['pending', 'in_progress'])
      .orderBy('id')
      .execute();
    return rows.map(toOp);
  }

  async markDone(id: string) {
    await this.db
      .updateTable('outbox_ops')
      .set({ status: 'done', last_error: null, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async markRetry(id: string, error: string, delayMs: number) {
    await this.db
      .updateTable('outbox_ops')
      .set({
        status: 'pending',
        last_error: error,
        next_attempt_at: sql<Date>`now() + make_interval(secs => ${Math.max(0, delayMs) / 1000})`,
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
