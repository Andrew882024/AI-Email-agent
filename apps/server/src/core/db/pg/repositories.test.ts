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

  describe('sync state', () => {
    it('stores, clears the full-sync checkpoint and keeps the tasks cursor', async () => {
      expect(await repos.syncState.get(accountId)).toEqual({ accountId, tasksSyncedAt: undefined });
      const checkpoint = {
        startedAt: new Date('2026-01-01T00:00:00Z'),
        historyId: '100',
        pageToken: 'p2',
        windowStart: new Date('2025-01-01T00:00:00Z'),
        synced: 500,
      };
      await repos.syncState.update(accountId, { fullSync: checkpoint });
      const tasksAt = new Date('2026-01-02T00:00:00Z');
      await repos.syncState.update(accountId, { tasksSyncedAt: tasksAt });
      expect(await repos.syncState.get(accountId)).toEqual({
        accountId,
        fullSync: checkpoint,
        tasksSyncedAt: tasksAt,
      });
      await repos.syncState.update(accountId, { fullSync: null });
      expect(await repos.syncState.get(accountId)).toEqual({ accountId, tasksSyncedAt: tasksAt });

      const begun = await repos.syncState.beginFullSync(accountId, { historyId: '200' });
      const { rows } = await sql<{ now: Date }>`select now() as now`.execute(t.db);
      expect(begun.startedAt.getTime()).toBeLessThanOrEqual(rows[0]!.now.getTime());
      expect(await repos.syncState.get(accountId)).toEqual({
        accountId,
        fullSync: { startedAt: begun.startedAt, historyId: '200', synced: 0 },
        tasksSyncedAt: tasksAt,
      });
    });
  });

  describe('chat tool runs', () => {
    it('stores runs on the message, finds them by id and resolves them concurrently', async () => {
      const session = await repos.chats.createSession(accountId);
      const message = await repos.chats.appendMessage(session.id, 'model', []);
      const runs = await repos.chats.createToolRuns(session.id, message.id, [
        {
          position: 1,
          tool: 'archive',
          input: { messageIds: ['m2'] },
          status: 'awaiting_approval',
        },
        {
          position: 0,
          callId: 'c1',
          tool: 'star',
          input: { messageIds: ['m1'] },
          status: 'awaiting_approval',
        },
        { position: 2, tool: 'list_labels', input: {}, status: 'done', result: { labels: [] } },
      ]);
      expect(runs.map((r) => [r.position, r.tool, r.messageId, r.sessionId])).toEqual([
        [0, 'star', message.id, session.id],
        [1, 'archive', message.id, session.id],
        [2, 'list_labels', message.id, session.id],
      ]);
      expect(runs[2]?.resolvedAt).toBeInstanceOf(Date);
      const [star, archive] = runs;
      expect(await repos.chats.getToolRun(star!.id)).toEqual(star);
      expect((await repos.chats.awaitingToolRuns(session.id)).map((r) => r.tool)).toEqual([
        'star',
        'archive',
      ]);
      // Messages keep their parts only; runs don't leak into the conversation.
      expect((await repos.chats.listMessages(session.id))[0]).not.toHaveProperty('toolRuns');

      await Promise.all([
        repos.chats.resolveToolRun(star!.id, { status: 'done', result: { updated: 1 } }),
        repos.chats.resolveToolRun(archive!.id, { status: 'rejected', result: null }),
      ]);
      const resolved = await repos.chats.listToolRuns(message.id);
      expect(resolved.map((r) => [r.tool, r.status, r.result])).toEqual([
        ['star', 'done', { updated: 1 }],
        ['archive', 'rejected', undefined],
        ['list_labels', 'done', { labels: [] }],
      ]);
      expect(resolved[0]?.resolvedAt).toBeInstanceOf(Date);
      expect(await repos.chats.awaitingToolRuns(session.id)).toEqual([]);
      expect(await repos.chats.getToolRun('00000000-0000-0000-0000-000000000000')).toBeUndefined();
    });
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
