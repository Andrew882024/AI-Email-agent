import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from '../../../test/helpers/db.js';
import type { MessageUpsert } from '../../domain/types.js';
import type { Repositories } from '../repositories.js';
import { createPgRepositories } from './index.js';

function message(id: string, overrides: Partial<MessageUpsert> = {}): MessageUpsert {
  return {
    id,
    threadId: `t-${id}`,
    from: { name: 'Alice', email: 'alice@example.com' },
    to: [{ email: 'me@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: `Subject ${id}`,
    snippet: `snippet ${id}`,
    bodyText: `body of ${id}`,
    internalDate: new Date('2026-01-01T00:00:00Z'),
    hasAttachments: false,
    labelIds: ['INBOX', 'UNREAD'],
    attachments: [],
    ...overrides,
  };
}

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

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

  describe('accounts', () => {
    it('upserts by googleSub and tracks sync state', async () => {
      const again = await repos.accounts.upsert({
        email: 'new@example.com',
        googleSub: 'sub-1',
        displayName: 'Me',
      });
      expect(again).toMatchObject({ id: accountId, email: 'new@example.com', displayName: 'Me' });

      await repos.accounts.updateSyncState(accountId, { historyId: '12345' });
      const synced = new Date('2026-02-01T00:00:00Z');
      await repos.accounts.updateSyncState(accountId, { lastFullSyncAt: synced });
      expect(await repos.accounts.getById(accountId)).toMatchObject({
        historyId: '12345',
        lastFullSyncAt: synced,
      });
      expect(await repos.accounts.list()).toHaveLength(1);

      await repos.accounts.delete(accountId);
      expect(await repos.accounts.getById(accountId)).toBeUndefined();
    });
  });

  describe('oauth tokens', () => {
    it('saves, replaces and deletes; cascades with the account', async () => {
      expect(await repos.oauthTokens.get(accountId)).toBeUndefined();
      await repos.oauthTokens.save(accountId, { encryptedRefreshToken: 'c1', scopes: ['a'] });
      await repos.oauthTokens.save(accountId, { encryptedRefreshToken: 'c2', scopes: ['a', 'b'] });
      expect(await repos.oauthTokens.get(accountId)).toMatchObject({
        accountId,
        encryptedRefreshToken: 'c2',
        scopes: ['a', 'b'],
      });
      await repos.oauthTokens.delete(accountId);
      expect(await repos.oauthTokens.get(accountId)).toBeUndefined();

      await repos.oauthTokens.save(accountId, { encryptedRefreshToken: 'c3', scopes: [] });
      await repos.accounts.delete(accountId);
      expect(await repos.oauthTokens.get(accountId)).toBeUndefined();
    });
  });

  describe('labels', () => {
    it('upserts, finds by name case-insensitively and replaces the full set', async () => {
      await repos.labels.upsert(accountId, [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        {
          id: 'Label_1',
          name: 'Invoices',
          type: 'user',
          color: { background: '#fff', text: '#000' },
        },
        { id: 'Label_2', name: 'Travel', type: 'user' },
      ]);
      expect(await repos.labels.findByName(accountId, 'invoices')).toEqual({
        id: 'Label_1',
        name: 'Invoices',
        type: 'user',
        color: { background: '#fff', text: '#000' },
      });

      await repos.messages.upsertMany(accountId, [
        message('m1', { labelIds: ['INBOX', 'Label_2'] }),
      ]);
      await repos.labels.replaceAll(accountId, [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_1', name: 'Bills', type: 'user' },
      ]);
      expect((await repos.labels.list(accountId)).map((l) => l.name)).toEqual(['INBOX', 'Bills']);
      // Label_2 was removed, so it must be detached from m1 too.
      expect((await repos.messages.getById(accountId, 'm1'))?.labelIds).toEqual(['INBOX']);

      await repos.messages.modifyLabels(accountId, ['m1'], { add: ['Label_1'] });
      await repos.labels.delete(accountId, 'Label_1');
      expect(await repos.labels.get(accountId, 'Label_1')).toBeUndefined();
      expect((await repos.messages.getById(accountId, 'm1'))?.labelIds).toEqual(['INBOX']);
    });
  });

  describe('messages', () => {
    it('round-trips a full message with attachments and derived flags', async () => {
      await repos.messages.upsertMany(accountId, [
        message('m1', {
          messageIdHeader: '<abc@mail>',
          cc: [{ name: 'Bob', email: 'bob@example.com' }],
          bodyHtml: '<p>hi</p>',
          hasAttachments: true,
          labelIds: ['STARRED', 'INBOX'],
          attachments: [
            {
              partId: '2',
              attachmentId: 'att-2',
              filename: 'b.pdf',
              mimeType: 'application/pdf',
              size: 20,
            },
            { partId: '1', filename: 'a.png', mimeType: 'image/png', size: 10, contentId: 'img1' },
          ],
        }),
      ]);
      const m = await repos.messages.getById(accountId, 'm1');
      expect(m).toMatchObject({
        id: 'm1',
        threadId: 't-m1',
        from: { name: 'Alice', email: 'alice@example.com' },
        cc: [{ name: 'Bob', email: 'bob@example.com' }],
        messageIdHeader: '<abc@mail>',
        bodyHtml: '<p>hi</p>',
        labelIds: ['INBOX', 'STARRED'],
        isRead: true,
        isStarred: true,
        inInbox: true,
      });
      expect(m?.attachments.map((a) => a.partId)).toEqual(['1', '2']);
      expect(m?.attachments[0]).toEqual({
        partId: '1',
        attachmentId: undefined,
        filename: 'a.png',
        mimeType: 'image/png',
        size: 10,
        contentId: 'img1',
      });
    });

    it('re-upserting replaces fields, labels and attachments', async () => {
      await repos.messages.upsertMany(accountId, [
        message('m1', {
          attachments: [{ partId: '1', filename: 'a', mimeType: 'text/plain', size: 1 }],
        }),
      ]);
      await repos.messages.upsertMany(accountId, [
        message('m1', { subject: 'Changed', labelIds: ['SENT'], attachments: [] }),
      ]);
      const m = await repos.messages.getById(accountId, 'm1');
      expect(m).toMatchObject({
        subject: 'Changed',
        labelIds: ['SENT'],
        inInbox: false,
        isRead: true,
      });
      expect(m?.attachments).toEqual([]);
    });

    it('lists newest first with cursor paging and label filters', async () => {
      await repos.messages.upsertMany(
        accountId,
        Array.from({ length: 5 }, (_, i) =>
          message(`m${i}`, {
            internalDate: at(i),
            labelIds: i % 2 === 0 ? ['INBOX', 'UNREAD'] : ['INBOX'],
          }),
        ),
      );

      const first = await repos.messages.list(accountId, { labelIds: ['INBOX'], limit: 2 });
      expect(first.items.map((m) => m.id)).toEqual(['m4', 'm3']);
      const second = await repos.messages.list(accountId, {
        labelIds: ['INBOX'],
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items.map((m) => m.id)).toEqual(['m2', 'm1']);
      const third = await repos.messages.list(accountId, {
        labelIds: ['INBOX'],
        limit: 2,
        cursor: second.nextCursor,
      });
      expect(third.items.map((m) => m.id)).toEqual(['m0']);
      expect(third.nextCursor).toBeUndefined();

      const unread = await repos.messages.list(accountId, {
        labelIds: ['INBOX', 'UNREAD'],
        limit: 10,
      });
      expect(unread.items.map((m) => m.id)).toEqual(['m4', 'm2', 'm0']);
      const read = await repos.messages.list(accountId, { excludeLabelIds: ['UNREAD'], limit: 10 });
      expect(read.items.map((m) => m.id)).toEqual(['m3', 'm1']);
    });

    it('breaks date ties by id so paging never skips or repeats', async () => {
      const same = new Date('2026-03-01T00:00:00Z');
      await repos.messages.upsertMany(
        accountId,
        ['a', 'b', 'c'].map((id) => message(id, { internalDate: same })),
      );
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await repos.messages.list(accountId, { limit: 1, cursor });
        ids.push(...page.items.map((m) => m.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toEqual(['c', 'b', 'a']);
    });

    it('rejects a malformed cursor', async () => {
      await expect(repos.messages.list(accountId, { limit: 1, cursor: 'garbage' })).rejects.toThrow(
        'Invalid cursor',
      );
    });

    it('searches subject, sender and body, including CJK subjects', async () => {
      await repos.messages.upsertMany(accountId, [
        message('m1', { subject: 'Your invoice for March', internalDate: at(1) }),
        message('m2', { bodyText: 'please find the invoice attached', internalDate: at(2) }),
        message('m3', { subject: '发票已开具', internalDate: at(3) }),
        message('m4', { from: { name: 'Bob', email: 'bob@shop.com' }, internalDate: at(4) }),
        message('m5', { subject: '100%_off', internalDate: at(5) }),
      ]);
      const search = async (q: string) =>
        (await repos.messages.list(accountId, { search: q, limit: 10 })).items.map((m) => m.id);
      expect(await search('invoice')).toEqual(['m2', 'm1']);
      expect(await search('发票')).toEqual(['m3']);
      expect(await search('shop.com')).toEqual(['m4']);
      expect(await search('%_')).toEqual(['m5']);
    });

    it('modifies labels like Gmail batchModify and ignores unknown ids', async () => {
      await repos.messages.upsertMany(accountId, [message('m1'), message('m2')]);
      await repos.messages.modifyLabels(accountId, ['m1', 'm2', 'missing'], {
        add: ['STARRED', 'Label_1'],
        remove: ['UNREAD', 'INBOX'],
      });
      const [m1, m2] = await Promise.all(
        ['m1', 'm2'].map((id) => repos.messages.getById(accountId, id)),
      );
      for (const m of [m1, m2]) {
        expect(m).toMatchObject({
          labelIds: ['Label_1', 'STARRED'],
          isRead: true,
          isStarred: true,
          inInbox: false,
        });
      }
      // Adding a label already present is a no-op.
      await repos.messages.modifyLabels(accountId, ['m1'], { add: ['STARRED'] });
      expect((await repos.messages.getById(accountId, 'm1'))?.labelIds).toEqual([
        'Label_1',
        'STARRED',
      ]);
    });

    it('returns a thread oldest first and deletes empty threads with their last message', async () => {
      await repos.messages.upsertMany(accountId, [
        message('m1', { threadId: 'T', internalDate: at(1) }),
        message('m2', { threadId: 'T', internalDate: at(2), snippet: 'latest' }),
      ]);
      expect((await repos.messages.getThread(accountId, 'T')).map((m) => m.id)).toEqual([
        'm1',
        'm2',
      ]);
      const thread = () =>
        t.db.selectFrom('threads').selectAll().where('id', '=', 'T').executeTakeFirst();
      expect(await thread()).toMatchObject({ snippet: 'latest', last_message_at: at(2) });

      await repos.messages.deleteMany(accountId, ['m1']);
      expect(await thread()).toBeDefined();
      await repos.messages.deleteMany(accountId, ['m2']);
      expect(await thread()).toBeUndefined();
    });

    it('sweeps messages not refreshed by a resync, within the window only', async () => {
      await repos.messages.upsertMany(accountId, [
        message('old-gone', { internalDate: new Date('2020-01-01T00:00:00Z') }),
        message('gone', { threadId: 'T1', internalDate: at(1) }),
        message('kept', { threadId: 'T1', internalDate: at(2) }),
      ]);
      // Same clock as updated_at (the DB's), like the real full sync uses.
      const { startedAt: resyncStarted } = await repos.syncState.beginFullSync(accountId, {
        historyId: '1',
      });
      await repos.messages.upsertMany(accountId, [
        message('kept', { threadId: 'T1', internalDate: at(2) }),
      ]);

      const swept = await repos.messages.sweepStale(accountId, {
        updatedBefore: resyncStarted,
        receivedSince: new Date('2025-01-01T00:00:00Z'),
      });
      expect(swept).toEqual(['gone']);
      expect(await repos.messages.getById(accountId, 'old-gone')).toBeDefined();
      expect(await repos.messages.getById(accountId, 'kept')).toBeDefined();
    });

    it('counts total and unread per label', async () => {
      await repos.messages.upsertMany(accountId, [
        message('m1', { labelIds: ['INBOX', 'UNREAD'] }),
        message('m2', { labelIds: ['INBOX'] }),
        message('m3', { labelIds: ['Label_1', 'UNREAD'] }),
      ]);
      expect(await repos.messages.countByLabel(accountId)).toEqual({
        INBOX: { total: 2, unread: 1 },
        UNREAD: { total: 2, unread: 2 },
        Label_1: { total: 1, unread: 1 },
      });
    });
  });

  describe('todos', () => {
    it('creates, finds, updates and deletes', async () => {
      const todo = await repos.todos.create({
        accountId,
        messageId: 'm1',
        googleTaskId: 'task-1',
        tasklistId: 'list-1',
        title: 'Pay invoice',
        due: new Date('2026-05-01T00:00:00Z'),
      });
      expect(todo).toMatchObject({ status: 'needsAction', title: 'Pay invoice' });
      const pending = await repos.todos.create({
        accountId,
        messageId: 'm2',
        title: 'Not pushed yet',
      });
      expect(pending).toMatchObject({ googleTaskId: undefined, tasklistId: undefined });
      expect(
        await repos.todos.update(pending.id, { googleTaskId: 'task-2', tasklistId: 'list-1' }),
      ).toMatchObject({
        googleTaskId: 'task-2',
        tasklistId: 'list-1',
      });
      expect((await repos.todos.getByGoogleTaskId(accountId, 'task-1'))?.id).toBe(todo.id);
      expect(await repos.todos.list(accountId, { messageId: 'm1' })).toHaveLength(1);

      const done = new Date('2026-04-01T00:00:00Z');
      const updated = await repos.todos.update(todo.id, {
        status: 'completed',
        completedAt: done,
        due: null,
      });
      expect(updated).toMatchObject({ status: 'completed', completedAt: done, due: undefined });
      expect(
        (await repos.todos.list(accountId, { status: 'needsAction' })).map((t) => t.id),
      ).toEqual([pending.id]);

      await repos.todos.delete(todo.id);
      expect(await repos.todos.getById(todo.id)).toBeUndefined();
    });
  });

  describe('outbox', () => {
    it('claims strictly FIFO per account, one op at a time', async () => {
      const a = await repos.outbox.enqueue(accountId, 'modify_labels', {
        ids: ['m1'],
        add: ['STARRED'],
      });
      const b = await repos.outbox.enqueue(accountId, 'send', { to: ['x@example.com'] });
      const other = (await repos.accounts.upsert({ email: 'o@example.com', googleSub: 'sub-2' }))
        .id;
      const c = await repos.outbox.enqueue(other, 'send', {});

      const first = await repos.outbox.claimNext(accountId);
      expect(first).toMatchObject({ id: a.id, status: 'in_progress', attempts: 1 });
      expect(first?.payload).toEqual({ ids: ['m1'], add: ['STARRED'] });
      // b waits while a is in progress; other accounts are independent.
      expect(await repos.outbox.claimNext(accountId)).toBeUndefined();
      expect((await repos.outbox.claimNext(other))?.id).toBe(c.id);

      // a waits for a retry: b must keep waiting behind it.
      await repos.outbox.markRetry(a.id, 'rate limited', 60_000);
      expect(await repos.outbox.claimNext(accountId)).toBeUndefined();
      expect((await repos.outbox.listActive(accountId)).map((op) => op.id)).toEqual([a.id, b.id]);

      await repos.outbox.markRetry(a.id, 'rate limited', 0);
      expect(await repos.outbox.claimNext(accountId)).toMatchObject({
        id: a.id,
        attempts: 2,
        lastError: 'rate limited',
      });
      await repos.outbox.markDone(a.id);
      expect((await repos.outbox.claimNext(accountId))?.id).toBe(b.id);

      // A failed op no longer blocks the queue.
      await repos.outbox.markFailed(b.id, 'bad request');
      expect(await repos.outbox.listActive(accountId)).toEqual([]);
      const d = await repos.outbox.enqueue(accountId, 'send', {});
      expect((await repos.outbox.claimNext(accountId))?.id).toBe(d.id);

      expect(await repos.outbox.requeueInProgress()).toBe(2); // d and c
      expect((await repos.outbox.claimNext(accountId))?.id).toBe(d.id);
    });
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
