import { sql } from 'kysely';
import type { Db } from '../shared/db/connection.js';
import type { FullSyncCheckpoint, SyncState } from '../shared/types.js';
import type { SyncStateRepository } from './repositories.js';

/** Per-account sync progress: incremental sync point, full-sync checkpoint, Tasks cursor. */
export class PgSyncStateRepository implements SyncStateRepository {
  constructor(private readonly db: Db) {}

  async get(accountId: string): Promise<SyncState> {
    const row = await this.db
      .selectFrom('sync_state')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return {
      accountId,
      historyId: row?.history_id ?? undefined,
      lastFullSyncAt: row?.last_full_sync_at ?? undefined,
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
    const values = {
      full_sync_started_at: sql<Date>`now()`,
      full_sync_history_id: input.historyId,
      full_sync_page_token: null,
      full_sync_window_start: input.windowStart ?? null,
      full_sync_count: 0,
    };
    const row = await this.db
      .insertInto('sync_state')
      .values({ account_id: accountId, ...values })
      .onConflict((oc) =>
        oc.column('account_id').doUpdateSet({ ...values, updated_at: sql`now()` }),
      )
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
    patch: {
      historyId?: string;
      lastFullSyncAt?: Date;
      fullSync?: FullSyncCheckpoint | null;
      tasksSyncedAt?: Date;
    },
  ) {
    const values = {
      ...(patch.historyId !== undefined && { history_id: patch.historyId }),
      ...(patch.lastFullSyncAt !== undefined && { last_full_sync_at: patch.lastFullSyncAt }),
      ...(patch.fullSync !== undefined && {
        full_sync_started_at: patch.fullSync?.startedAt ?? null,
        full_sync_history_id: patch.fullSync?.historyId ?? null,
        full_sync_page_token: patch.fullSync?.pageToken ?? null,
        full_sync_window_start: patch.fullSync?.windowStart ?? null,
        full_sync_count: patch.fullSync?.synced ?? 0,
      }),
      ...(patch.tasksSyncedAt !== undefined && { tasks_synced_at: patch.tasksSyncedAt }),
    };
    await this.db
      .insertInto('sync_state')
      .values({ account_id: accountId, ...values })
      .onConflict((oc) =>
        oc.column('account_id').doUpdateSet({ ...values, updated_at: sql`now()` }),
      )
      .execute();
  }
}
