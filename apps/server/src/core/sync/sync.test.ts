import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGateways, googleError } from '../../../test/helpers/fake-google.js';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from '../../../test/helpers/db.js';
import { ReauthRequiredError } from '../auth/errors.js';
import { createPgRepositories } from '../db/pg/index.js';
import type { Repositories } from '../db/repositories.js';
import { type AppEventName, type AppEvents, EventBus } from '../events/event-bus.js';
import { ActionLogger } from '../logging/action-logger.js';
import { FakeEmbeddings } from '../../../test/helpers/fake-llm.js';
import { EmailIndexer } from '../rag/indexer.js';
import { MailSync } from './mail-sync.js';
import { MailboxService } from './mailbox.js';
import { OutboxWorker } from './outbox-worker.js';
import { SyncScheduler } from './scheduler.js';
import { TasksSync } from './tasks-sync.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describe.skipIf(!testDatabaseUrl)('sync', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let accountId: string;
  let google: FakeGateways;
  let events: EventBus;
  let seen: { event: AppEventName; payload: unknown }[];
  let mailSync: MailSync;
  let mailbox: MailboxService;
  let worker: OutboxWorker;
  let tasksSync: TasksSync;
  const logger = pino({ level: 'silent' });

  const build = (windowDays = 30) => {
    const actions = new ActionLogger(repos.actionLogs, logger);
    mailSync = new MailSync({
      repos,
      gateways: google,
      events,
      actions,
      logger,
      windowDays,
      fetchConcurrency: 3,
    });
    mailbox = new MailboxService(repos, events);
    worker = new OutboxWorker({
      repos,
      gateways: google,
      events,
      actions,
      logger,
      mailSync,
      retryDelayMs: () => 0,
      maxAttempts: 3,
    });
    tasksSync = new TasksSync(repos, google, events);
  };
  const labelsOf = async (id: string) => (await repos.messages.getById(accountId, id))?.labelIds;
  const eventsOf = <K extends AppEventName>(name: K) =>
    seen.filter((e) => e.event === name).map((e) => e.payload as AppEvents[K]);

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    await sql`truncate action_logs`.execute(t.db);
    accountId = (await repos.accounts.upsert({ email: 'me@example.com', googleSub: 'sub' })).id;
    google = new FakeGateways();
    events = new EventBus(logger);
    seen = [];
    const names: AppEventName[] = [
      'message.added',
      'message.updated',
      'message.deleted',
      'labels.changed',
      'todos.changed',
      'sync.status',
      'outbox.enqueued',
      'outbox.failed',
      'index.status',
    ];
    for (const name of names)
      events.on(name, (payload) => void seen.push({ event: name, payload }));
    build();
  });

  describe('full sync', () => {
    it('syncs labels and every message inside the window, then records the history id', async () => {
      const gmail = google.fakeGmail;
      for (let i = 1; i <= 5; i++) gmail.add({ id: `m${i}`, date: daysAgo(i) }, false);
      gmail.add({ id: 'ancient', date: daysAgo(400) }, false);

      expect(await mailSync.sync(accountId)).toEqual({ kind: 'full', synced: 5, deleted: 0 });

      const { items } = await repos.messages.list(accountId, { limit: 50 });
      expect(items.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      expect(items[0]).toMatchObject({ subject: 'Subject m1', isRead: false, inInbox: true });
      expect((await repos.labels.list(accountId)).map((l) => l.id)).toContain('STARRED');
      expect((await repos.accounts.getById(accountId))?.historyId).toBe(String(gmail.historyId));
      expect((await repos.syncState.get(accountId)).fullSync).toBeUndefined();
      expect(eventsOf('labels.changed')).toHaveLength(1);
      expect(eventsOf('message.added')).toEqual([]); // backfill is not new mail
      expect(eventsOf('sync.status').at(-1)).toEqual({ accountId, phase: 'idle' });
      const { items: logs } = await repos.actionLogs.query({ action: 'sync.full', limit: 5 });
      expect(logs[0]).toMatchObject({
        actor: 'sync',
        status: 'success',
        params: expect.objectContaining({ synced: 5 }),
      });
    });

    it('resumes from the last checkpoint after an interruption', async () => {
      const gmail = google.fakeGmail;
      for (let i = 1; i <= 6; i++) gmail.add({ id: `m${i}`, date: daysAgo(i) }, false);
      // Pages are 2 messages each: fail while fetching the 3rd page.
      gmail.failures.getMessage = [
        undefined,
        undefined,
        undefined,
        undefined,
        googleError(400, 'boom'),
      ];

      await expect(mailSync.sync(accountId)).rejects.toThrow('boom');
      const { fullSync } = await repos.syncState.get(accountId);
      expect(fullSync).toMatchObject({ pageToken: '4', synced: 4 });
      expect(gmail.calls.getMessage).toBe(6);

      build(); // simulate an app restart
      expect(await mailSync.sync(accountId)).toMatchObject({ kind: 'full', synced: 6 });
      expect(gmail.calls.getMessage).toBe(8); // only the unfinished page was fetched again
      expect((await repos.messages.list(accountId, { limit: 50 })).items).toHaveLength(6);
    });
  });

  it('can finish a full sync early, keeping what it synced and replaying later changes', async () => {
    const gmail = google.fakeGmail;
    for (let i = 1; i <= 6; i++) gmail.add({ id: `m${i}`, date: daysAgo(i) }, false);
    gmail.failures.getMessage = [undefined, undefined, googleError(400, 'stop')]; // dies on page 2
    await expect(mailSync.sync(accountId)).rejects.toThrow('stop');
    gmail.add({ id: 'new' }); // arrives while the full sync is paused

    expect(await mailSync.finishFullSyncEarly(accountId)).toBe(true);
    expect(await mailSync.finishFullSyncEarly(accountId)).toBe(false);
    expect(await mailSync.sync(accountId)).toMatchObject({ kind: 'incremental', added: 1 });
    const ids = (await repos.messages.list(accountId, { limit: 50 })).items.map((m) => m.id);
    expect(ids).toEqual(['new', 'm1', 'm2']);
  });

  describe('incremental sync', () => {
    beforeEach(async () => {
      google.fakeGmail.add({ id: 'm1', date: daysAgo(1) }, false);
      google.fakeGmail.add({ id: 'm2', date: daysAgo(2) }, false);
      await mailSync.sync(accountId);
      seen = [];
    });

    it('applies new mail, web-side label changes and deletions', async () => {
      const gmail = google.fakeGmail;
      gmail.add({ id: 'm3', subject: 'Fresh' });
      gmail.relabel('m1', { add: ['STARRED'], remove: ['UNREAD'] });
      gmail.relabel('m1', { remove: ['INBOX'] });
      gmail.remove('m2');

      expect(await mailSync.sync(accountId)).toEqual({
        kind: 'incremental',
        added: 1,
        updated: 1,
        deleted: 1,
      });
      expect(await labelsOf('m1')).toEqual(['STARRED']);
      expect(await labelsOf('m3')).toEqual(['INBOX', 'UNREAD']);
      expect(await repos.messages.getById(accountId, 'm2')).toBeUndefined();
      expect((await repos.accounts.getById(accountId))?.historyId).toBe(String(gmail.historyId));
      expect(eventsOf('message.added')).toEqual([{ accountId, messageIds: ['m3'] }]);
      expect(eventsOf('message.updated')).toEqual([{ accountId, messageIds: ['m1'] }]);
      expect(eventsOf('message.deleted')).toEqual([{ accountId, messageIds: ['m2'] }]);

      expect(await mailSync.sync(accountId)).toEqual({
        kind: 'incremental',
        added: 0,
        updated: 0,
        deleted: 0,
      });
    });

    it('falls back to a full resync when history expired, removing mail deleted meanwhile', async () => {
      const gmail = google.fakeGmail;
      gmail.messages.delete('m2'); // deleted while our history pointer was too old to see it
      gmail.add({ id: 'm3' });
      gmail.expiredBefore = gmail.historyId + 1;

      expect(await mailSync.sync(accountId)).toEqual({ kind: 'full', synced: 2, deleted: 1 });
      expect(
        (await repos.messages.list(accountId, { limit: 10 })).items.map((m) => m.id).sort(),
      ).toEqual(['m1', 'm3']);
    });
  });

  describe('outbox', () => {
    beforeEach(async () => {
      google.fakeGmail.add({ id: 'm1', date: daysAgo(1) }, false);
      google.fakeGmail.add({ id: 'm2', date: daysAgo(2) }, false);
      await mailSync.sync(accountId);
    });

    it('applies locally at once and pushes to Gmail in order', async () => {
      await mailbox.modifyLabels(accountId, ['m1', 'm2'], { add: ['STARRED'], remove: ['UNREAD'] });
      await mailbox.modifyLabels(accountId, ['m1'], { remove: ['STARRED', 'INBOX'] });
      expect(await labelsOf('m1')).toEqual([]);
      expect(google.fakeGmail.labelsOf('m1')).toEqual(['INBOX', 'UNREAD']); // not pushed yet

      expect(await worker.drain(accountId)).toBe(2);
      expect(google.fakeGmail.labelsOf('m1')).toEqual([]);
      expect(google.fakeGmail.labelsOf('m2')).toEqual(['INBOX', 'STARRED']);
      expect(await repos.outbox.listActive(accountId)).toEqual([]);

      // Our own pushes come back through history and change nothing.
      await mailSync.sync(accountId);
      expect(await labelsOf('m1')).toEqual([]);
    });

    it('keeps unpushed changes visible when fresh Gmail state is pulled', async () => {
      await mailbox.modifyLabels(accountId, ['m1'], { add: ['STARRED'] });
      google.fakeGmail.expiredBefore = google.fakeGmail.historyId + 1; // forces refetch of m1
      await mailSync.sync(accountId);
      expect(await labelsOf('m1')).toEqual(['INBOX', 'STARRED', 'UNREAD']);
    });

    it('retries transient failures and keeps later ops waiting behind them', async () => {
      google.fakeGmail.failures.modifyMessages = [googleError(503)];
      await mailbox.modifyLabels(accountId, ['m1'], { add: ['STARRED'] });
      await mailbox.modifyLabels(accountId, ['m1'], { remove: ['STARRED'] });

      expect(await worker.drain(accountId)).toBe(3); // star (fails), star (retry), unstar
      expect(google.fakeGmail.labelsOf('m1')).toEqual(['INBOX', 'UNREAD']);
      expect(eventsOf('outbox.failed')).toEqual([]);
    });

    it('gives up on permanent errors and restores the Gmail state locally', async () => {
      google.fakeGmail.failures.modifyMessages = [googleError(400, 'Invalid label')];
      await mailbox.modifyLabels(accountId, ['m1'], { add: ['Label_missing'], remove: ['INBOX'] });
      expect(await labelsOf('m1')).toEqual(['Label_missing', 'UNREAD']);

      await worker.drain(accountId);
      expect(await labelsOf('m1')).toEqual(['INBOX', 'UNREAD']);
      expect(eventsOf('outbox.failed')).toEqual([
        { accountId, op: 'modify_labels', error: 'Invalid label' },
      ]);
      const { items } = await repos.actionLogs.query({ action: 'outbox.modify_labels', limit: 5 });
      expect(items[0]).toMatchObject({
        status: 'error',
        targetIds: ['m1'],
        error: 'Invalid label',
      });
    });

    it('holds ops while the account needs reconnecting', async () => {
      await mailbox.modifyLabels(accountId, ['m1'], { add: ['STARRED'] });
      google.failWith = new ReauthRequiredError(accountId, 'expired');
      expect(await worker.drain(accountId)).toBe(1);
      const [op] = await repos.outbox.listActive(accountId);
      expect(op).toMatchObject({
        status: 'pending',
        lastError: expect.stringContaining('reconnected'),
      });
      expect(op!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
      expect(eventsOf('sync.status').at(-1)).toMatchObject({ phase: 'reauth_required' });
    });

    it('sends raw messages and pulls the sent copy in', async () => {
      await mailbox.send(accountId, { raw: 'Subject: hi\r\n\r\nbody', threadId: 't-m1' });
      await worker.drain(accountId);
      expect(google.fakeGmail.sent).toEqual([{ raw: 'Subject: hi\r\n\r\nbody', threadId: 't-m1' }]);
      await mailSync.sync(accountId);
      expect(
        (await repos.messages.getThread(accountId, 't-m1')).map((m) => m.labelIds),
      ).toContainEqual(['SENT']);
    });

    it('rejects adding and removing the same label', async () => {
      await expect(
        mailbox.modifyLabels(accountId, ['m1'], { add: ['X'], remove: ['X'] }),
      ).rejects.toThrow('both added and removed');
    });
  });

  describe('todos', () => {
    beforeEach(async () => {
      google.fakeGmail.add({ id: 'm1', date: daysAgo(1) }, false);
      await mailSync.sync(accountId);
    });

    it('creates the Google Task with a link back to the message', async () => {
      const todo = await mailbox.addTodo(accountId, {
        messageId: 'm1',
        title: 'Reply to Alice',
        notes: 'by Friday',
      });
      expect(todo.googleTaskId).toBeUndefined();
      await worker.drain(accountId);

      const [task] = [...google.fakeTasks.tasks.values()];
      expect(task).toMatchObject({ title: 'Reply to Alice', tasklistId: 'list-default' });
      expect(task!.notes).toBe(
        'by Friday\n\nhttps://mail.google.com/mail/?authuser=me%40example.com#all/m1',
      );
      expect(await repos.todos.getById(todo.id)).toMatchObject({
        googleTaskId: task!.id,
        tasklistId: 'list-default',
      });
    });

    it('mirrors completion and deletion done in Google Tasks', async () => {
      const done = await mailbox.addTodo(accountId, { messageId: 'm1', title: 'A' });
      const gone = await mailbox.addTodo(accountId, { messageId: 'm1', title: 'B' });
      await worker.drain(accountId);
      const taskId = async (id: string) => (await repos.todos.getById(id))!.googleTaskId!;
      google.fakeTasks.complete(await taskId(done.id));
      google.fakeTasks.deleteRemotely(await taskId(gone.id));

      expect(await tasksSync.sync(accountId)).toEqual({ updated: 1, deleted: 1 });
      expect(await repos.todos.getById(done.id)).toMatchObject({
        status: 'completed',
        completedAt: expect.any(Date),
      });
      expect(await repos.todos.getById(gone.id)).toBeUndefined();
      expect(await tasksSync.sync(accountId)).toEqual({ updated: 0, deleted: 0 });
    });

    it('removes the Google Task, or never creates it if removed first', async () => {
      const pushed = await mailbox.addTodo(accountId, { messageId: 'm1', title: 'pushed' });
      await worker.drain(accountId);
      expect(await mailbox.removeTodo(accountId, pushed.id)).toBe(true);
      const early = await mailbox.addTodo(accountId, { messageId: 'm1', title: 'early' });
      expect(await mailbox.removeTodo(accountId, early.id)).toBe(true);
      await worker.drain(accountId);
      expect(google.fakeTasks.tasks.size).toBe(0);
      expect(await mailbox.removeTodo(accountId, early.id)).toBe(false);
    });

    it('drops the local todo if the task cannot be created', async () => {
      google.fakeTasks.failures.createTask = [googleError(400)];
      const todo = await mailbox.addTodo(accountId, { messageId: 'm1', title: 'x' });
      await worker.drain(accountId);
      expect(await repos.todos.getById(todo.id)).toBeUndefined();
      expect(eventsOf('outbox.failed')).toHaveLength(1);
    });
  });

  describe('scheduler', () => {
    it('syncs connected accounts in the background and pushes changes as they are queued', async () => {
      google.fakeGmail.add({ id: 'm1', date: daysAgo(1) }, false);
      const scheduler = new SyncScheduler({
        repos,
        auth: { isConnected: async () => true },
        mailSync,
        tasksSync,
        outbox: worker,
        events,
        logger,
        mailIntervalMs: 50,
        outboxIntervalMs: 10_000,
      });
      await scheduler.start();
      try {
        await expect.poll(() => labelsOf('m1'), { timeout: 2000 }).toEqual(['INBOX', 'UNREAD']);
        google.fakeGmail.add({ id: 'm2' });
        await expect.poll(() => labelsOf('m2'), { timeout: 2000 }).toBeDefined();
        await mailbox.modifyLabels(accountId, ['m1'], { add: ['STARRED'] });
        await expect
          .poll(() => google.fakeGmail.labelsOf('m1'), { timeout: 2000 })
          .toContain('STARRED');
      } finally {
        await scheduler.stop();
      }
    });

    it('indexes new mail for semantic search as it arrives', async () => {
      const embeddings = new FakeEmbeddings();
      const scheduler = new SyncScheduler({
        repos,
        auth: { isConnected: async () => true },
        mailSync,
        tasksSync,
        outbox: worker,
        events,
        logger,
        mailIntervalMs: 50,
        indexer: new EmailIndexer({ repos, embeddings, events, logger }),
        indexIntervalMs: 60_000,
      });
      await scheduler.start();
      try {
        google.fakeGmail.add({ id: 'm1', subject: 'Quarterly report' });
        await expect
          .poll(async () => (await repos.vectors.stats(accountId, 'fake-embed')).indexed, {
            timeout: 3000,
          })
          .toBe(1);
        expect(eventsOf('index.status').at(-1)).toMatchObject({
          phase: 'idle',
          indexed: 1,
          total: 1,
        });
      } finally {
        await scheduler.stop();
      }
    });

    it("runs each account on its own, so one account's long sync doesn't hold up another", async () => {
      const other = (await repos.accounts.upsert({ email: 'b@example.com', googleSub: 'b' })).id;
      const calls: string[] = [];
      let releaseFirst!: () => void;
      const firstStuck = new Promise<void>((resolve) => (releaseFirst = resolve));
      const scheduler = new SyncScheduler({
        repos,
        auth: { isConnected: async () => true },
        mailSync: {
          sync: async (id: string) => {
            calls.push(id);
            if (id === accountId) await firstStuck; // e.g. a first full sync of a big mailbox
          },
        } as unknown as MailSync,
        tasksSync: { sync: async () => 0 } as unknown as TasksSync,
        outbox: { drain: async () => 0 } as unknown as OutboxWorker,
        events,
        logger,
        mailIntervalMs: 20,
      });
      await scheduler.start();
      try {
        await expect
          .poll(() => calls.filter((id) => id === other).length, { timeout: 2000 })
          .toBeGreaterThan(3);
        expect(calls.filter((id) => id === accountId)).toHaveLength(1);

        await scheduler.removeAccount(other);
        const after = calls.length;
        scheduler.syncNow(other);
        await new Promise((r) => setTimeout(r, 100));
        expect(calls.length).toBe(after);
      } finally {
        releaseFirst();
        await scheduler.stop();
      }
    });

    it('reports accounts that need reconnecting without stopping', async () => {
      google.failWith = new ReauthRequiredError(accountId, 'expired');
      const scheduler = new SyncScheduler({
        repos,
        auth: { isConnected: async () => true },
        mailSync,
        tasksSync,
        outbox: worker,
        events,
        logger,
        mailIntervalMs: 10_000,
      });
      await scheduler.start();
      await expect
        .poll(() => eventsOf('sync.status').some((s) => s.phase === 'reauth_required'))
        .toBe(true);
      await scheduler.stop();
    });
  });
});
