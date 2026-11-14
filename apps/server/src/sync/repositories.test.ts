import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgAccountRepository } from '../auth/index.js';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../shared/testing/db.js';
import { PgSyncStateRepository } from './sync-state-repository.js';

describe.skipIf(!testDatabaseUrl)('sync repositories', () => {
  let t: TestDatabase;
  let accounts: PgAccountRepository;
  let syncState: PgSyncStateRepository;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    accounts = new PgAccountRepository(t.db);
    syncState = new PgSyncStateRepository(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    accountId = (await accounts.upsert({ email: 'me@example.com', googleSub: 'sub-1' })).id;
  });

  describe('sync state', () => {
    it('stores, clears the full-sync checkpoint and keeps the tasks cursor', async () => {
      expect(await syncState.get(accountId)).toEqual({ accountId });
      const checkpoint = {
        startedAt: new Date('2026-01-01T00:00:00Z'),
        historyId: '100',
        pageToken: 'p2',
        windowStart: new Date('2025-01-01T00:00:00Z'),
        synced: 500,
      };
      await syncState.update(accountId, { fullSync: checkpoint });
      const tasksAt = new Date('2026-01-02T00:00:00Z');
      await syncState.update(accountId, { tasksSyncedAt: tasksAt });
      expect(await syncState.get(accountId)).toEqual({
        accountId,
        fullSync: checkpoint,
        tasksSyncedAt: tasksAt,
      });
      await syncState.update(accountId, { fullSync: null });
      expect(await syncState.get(accountId)).toEqual({ accountId, tasksSyncedAt: tasksAt });

      const begun = await syncState.beginFullSync(accountId, { historyId: '200' });
      const { rows } = await sql<{ now: Date }>`select now() as now`.execute(t.db);
      expect(begun.startedAt.getTime()).toBeLessThanOrEqual(rows[0]!.now.getTime());
      expect(await syncState.get(accountId)).toEqual({
        accountId,
        fullSync: { startedAt: begun.startedAt, historyId: '200', synced: 0 },
        tasksSyncedAt: tasksAt,
      });
    });

    it('keeps the incremental sync point and goes with the account', async () => {
      const at = new Date('2026-02-01T00:00:00Z');
      await syncState.update(accountId, { historyId: '12345', lastFullSyncAt: at });
      await syncState.update(accountId, { tasksSyncedAt: at });
      expect(await syncState.get(accountId)).toEqual({
        accountId,
        historyId: '12345',
        lastFullSyncAt: at,
        tasksSyncedAt: at,
      });
      await accounts.delete(accountId);
      const { rows } = await sql`select 1 from sync_state`.execute(t.db);
      expect(rows).toEqual([]);
    });
  });
});
