import type { FastifyInstance } from 'fastify';
import type { RequestAccount } from '../auth/routes.js';
import type { OutboxRepository } from '../mailbox/repositories.js';
import type { SyncStateRepository } from './repositories.js';
import type { SyncScheduler } from './scheduler.js';

export interface SyncRouteDeps {
  access: RequestAccount;
  syncState: SyncStateRepository;
  outbox: Pick<OutboxRepository, 'listActive'>;
  scheduler: Pick<SyncScheduler, 'syncNow'>;
}

/** Sync progress, and "sync now" for the refresh button. */
export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps): void {
  const { access } = deps;

  app.get('/api/sync/status', async (req) => {
    const account = await access.requireAccount(req);
    const [state, pending] = await Promise.all([
      deps.syncState.get(account.id),
      deps.outbox.listActive(account.id),
    ]);
    return {
      historyId: state.historyId,
      lastFullSyncAt: state.lastFullSyncAt,
      fullSync: state.fullSync,
      outboxPending: pending.length,
    };
  });

  app.post('/api/sync/now', async (req) => {
    deps.scheduler.syncNow((await access.requireAccount(req)).id);
    return { ok: true };
  });
}
