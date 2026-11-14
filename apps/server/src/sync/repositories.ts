// Storage contract of the sync module's table (sync_state).
import type { FullSyncCheckpoint, SyncState } from '../shared/types.js';

export interface SyncStateRepository {
  get(accountId: string): Promise<SyncState>;
  /**
   * Start a full-sync checkpoint. startedAt comes from the database clock, the same clock that
   * stamps messages.updated_at, so the end-of-sync sweep can't be fooled by host/DB clock skew.
   */
  beginFullSync(
    accountId: string,
    input: { historyId: string; windowStart?: Date },
  ): Promise<FullSyncCheckpoint>;
  /** `fullSync: null` clears the checkpoint (full sync finished). */
  update(
    accountId: string,
    patch: {
      historyId?: string;
      lastFullSyncAt?: Date;
      fullSync?: FullSyncCheckpoint | null;
      tasksSyncedAt?: Date;
    },
  ): Promise<void>;
}
