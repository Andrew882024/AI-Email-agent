import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from '../../../shared/testing/db.js';
import type { Repositories } from '../repositories.js';
import { createPgRepositories } from './index.js';

describe.skipIf(!testDatabaseUrl)('Postgres repositories', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    await sql`truncate action_logs`.execute(t.db);
    await sql`truncate outbox_ops`.execute(t.db);
    accountId = (await repos.accounts.upsert({ email: 'me@example.com', googleSub: 'sub-1' })).id;
  });

  describe('action logs', () => {
    it('inserts and queries newest first with filters and paging', async () => {
      for (let i = 0; i < 3; i++) {
        await repos.actionLogs.insert({
          accountId,
          actor: 'user',
          action: 'star',
          targetIds: [`m${i}`],
          params: { i },
          status: 'success',
          durationMs: 5,
        });
      }
      await repos.actionLogs.insert({
        actor: 'workflow:wf1',
        action: 'archive',
        status: 'error',
        error: 'boom',
      });

      const page1 = await repos.actionLogs.query({ actor: 'user', limit: 2 });
      expect(page1.items.map((e) => e.targetIds[0])).toEqual(['m2', 'm1']);
      expect(page1.items[0]).toMatchObject({
        accountId,
        action: 'star',
        params: { i: 2 },
        durationMs: 5,
      });
      const page2 = await repos.actionLogs.query({
        actor: 'user',
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.items.map((e) => e.targetIds[0])).toEqual(['m0']);
      expect(page2.nextCursor).toBeUndefined();

      const errors = await repos.actionLogs.query({ status: 'error', limit: 10 });
      expect(errors.items).toEqual([
        expect.objectContaining({
          actor: 'workflow:wf1',
          error: 'boom',
          targetIds: [],
          params: undefined,
        }),
      ]);
      expect(
        (await repos.actionLogs.query({ since: new Date(Date.now() + 60_000), limit: 10 })).items,
      ).toEqual([]);
    });

    it('keeps log entries when the account is deleted', async () => {
      await repos.actionLogs.insert({
        accountId,
        actor: 'user',
        action: 'star',
        status: 'success',
      });
      await repos.accounts.delete(accountId);
      const { items } = await repos.actionLogs.query({ limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]?.accountId).toBeUndefined();
    });
  });
});
