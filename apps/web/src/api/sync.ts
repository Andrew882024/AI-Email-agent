import { z } from 'zod';
import { IsoDate, Ok, optional, request } from './client';

export const SyncStatus = z.object({
  historyId: optional(z.string()),
  lastFullSyncAt: optional(IsoDate),
  fullSync: optional(z.object({ synced: z.number() })),
  outboxPending: z.number(),
});
export type SyncStatus = z.output<typeof SyncStatus>;

export const SyncPhase = z.enum(['idle', 'full_sync', 'incremental', 'error', 'reauth_required']);
export type SyncPhase = z.output<typeof SyncPhase>;

export const getSyncStatus = () => request(SyncStatus, '/api/sync/status');

/** Ask the server to sync with Gmail now instead of at the next poll. */
export const syncNow = () => request(Ok, '/api/sync/now', { method: 'POST' });
