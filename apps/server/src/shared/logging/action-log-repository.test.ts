import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../testing/db.js';
import { PgActionLogRepository } from './action-log-repository.js';

describe.skipIf(!testDatabaseUrl)('action log repository', () => {
  let t: TestDatabase;
  let actionLogs: PgActionLogRepository;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    actionLogs = new PgActionLogRepository(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    await sql`truncate action_logs`.execute(t.db);
    accountId = (
      await sql<{ id: string }>`insert into accounts (email, google_sub)
        values ('me@example.com', 'sub-1') returning id`.execute(t.db)
    ).rows[0]!.id;
  });

  describe('action logs', () => {
    it('inserts and queries newest first with filters and paging', async () => {
      for (let i = 0; i < 3; i++) {
        await actionLogs.insert({
          accountId,
          actor: 'user',
          action: 'star',
          targetIds: [`m${i}`],
          params: { i },
          status: 'success',
          durationMs: 5,
        });
      }
      await actionLogs.insert({
        actor: 'workflow:wf1',
        action: 'archive',
        status: 'error',
        error: 'boom',
      });

      const page1 = await actionLogs.query({ actor: 'user', limit: 2 });
      expect(page1.items.map((e) => e.targetIds[0])).toEqual(['m2', 'm1']);
      expect(page1.items[0]).toMatchObject({
        accountId,
        action: 'star',
        params: { i: 2 },
        durationMs: 5,
      });
      const page2 = await actionLogs.query({
        actor: 'user',
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.items.map((e) => e.targetIds[0])).toEqual(['m0']);
      expect(page2.nextCursor).toBeUndefined();

      const errors = await actionLogs.query({ status: 'error', limit: 10 });
      expect(errors.items).toEqual([
        expect.objectContaining({
          actor: 'workflow:wf1',
          error: 'boom',
          targetIds: [],
          params: undefined,
        }),
      ]);
      expect(
        (await actionLogs.query({ since: new Date(Date.now() + 60_000), limit: 10 })).items,
      ).toEqual([]);
    });

    it('keeps log entries when the account is deleted', async () => {
      await actionLogs.insert({
        accountId,
        actor: 'user',
        action: 'star',
        status: 'success',
      });
      await sql`delete from accounts where id = ${accountId}`.execute(t.db);
      const { items } = await actionLogs.query({ limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]?.accountId).toBeUndefined();
    });
  });
});
