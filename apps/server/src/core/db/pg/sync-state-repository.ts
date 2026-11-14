import { sql } from 'kysely';
import type { FullSyncCheckpoint, SyncState } from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { SyncStateRepository } from '../repositories.js';

/** Full-sync checkpoint and Tasks polling cursor, kept in columns of `accounts`. */
export class PgSyncStateRepository implements SyncStateRepository {
  constructor(private readonly db: Db) {}

  async get(accountId: string): Promise<SyncState> {
    const row = await this.db
      .selectFrom('accounts')
      .select([
        'full_sync_started_at',
        'full_sync_history_id',
        'full_sync_page_token',
        'full_sync_window_start',
        'full_sync_count',
        'tasks_synced_at',
      ])
      .where('id', '=', accountId)
      .executeTakeFirst();
    return {
      accountId,
      ...(row?.full_sync_started_at &&
        row.full_sync_history_id && {
          fullSync: {
            startedAt: row.full_sync_started_at,
            historyId: row.full_sync_history_id,
            pageToken: row.full_sync_page_token ?? undefined,
            windowStart: row.full_sync_window_start ?? undefined,
            synced: row.full_sync_count,
          },
        }),
      tasksSyncedAt: row?.tasks_synced_at ?? undefined,
    };
  }

  async beginFullSync(accountId: string, input: { historyId: string; windowStart?: Date }) {
    const row = await this.db
      .updateTable('accounts')
      .set({
        full_sync_started_at: sql<Date>`now()`,
        full_sync_history_id: input.historyId,
        full_sync_page_token: null,
        full_sync_window_start: input.windowStart ?? null,
        full_sync_count: 0,
      })
      .where('id', '=', accountId)
      .returning('full_sync_started_at')
      .executeTakeFirstOrThrow();
    return {
      startedAt: row.full_sync_started_at!,
      historyId: input.historyId,
      synced: 0,
      ...(input.windowStart && { windowStart: input.windowStart }),
    };
  }

  async update(
    accountId: string,
    patch: { fullSync?: FullSyncCheckpoint | null; tasksSyncedAt?: Date },
  ) {
    const values = {
      ...(patch.fullSync !== undefined && {
        full_sync_started_at: patch.fullSync?.startedAt ?? null,
        full_sync_history_id: patch.fullSync?.historyId ?? null,
        full_sync_page_token: patch.fullSync?.pageToken ?? null,
        full_sync_window_start: patch.fullSync?.windowStart ?? null,
        full_sync_count: patch.fullSync?.synced ?? 0,
      }),
      ...(patch.tasksSyncedAt !== undefined && { tasks_synced_at: patch.tasksSyncedAt }),
    };
    if (Object.keys(values).length === 0) return;
    await this.db.updateTable('accounts').set(values).where('id', '=', accountId).execute();
  }
}
