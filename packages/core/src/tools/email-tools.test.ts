import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../../test/helpers/db.js';
import { FakeGateways } from '../../test/helpers/fake-google.js';
import { createPgRepositories } from '../db/pg/index.js';
import type { Repositories } from '../db/repositories.js';
import { EventBus } from '../events/event-bus.js';
import { ActionLogger } from '../logging/action-logger.js';
import { MailSync } from '../sync/mail-sync.js';
import { HybridSearch } from '../rag/hybrid-search.js';
import { MailboxService } from '../sync/mailbox.js';
import { OutboxWorker } from '../sync/outbox-worker.js';
import { createEmailTools } from './email-tools.js';
import { type ToolContext, ToolError, ToolRegistry } from './registry.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe.skipIf(!testDatabaseUrl)('email tools', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let google: FakeGateways;
  let tools: ToolRegistry;
  let worker: OutboxWorker;
  let ctx: ToolContext;
  const logger = pino({ level: 'silent' });

  const call = (name: string, input: unknown = {}) => tools.invoke(name, ctx, input);
  const labelsOf = async (id: string) =>
    (await repos.messages.getById(ctx.accountId, id))?.labelIds;
  const sentRaw = async () => {
    await worker.drain(ctx.accountId);
    return google.fakeGmail.sent.at(-1);
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    await sql`truncate action_logs`.execute(t.db);
    const accountId = (
      await repos.accounts.upsert({
        email: 'me@example.com',
        googleSub: 's',
        displayName: 'Me Myself',
      })
    ).id;
    ctx = { accountId, actor: 'user' };
    google = new FakeGateways();
    const events = new EventBus(logger);
    const actions = new ActionLogger(repos.actionLogs, logger);
    const mailSync = new MailSync({
      repos,
      gateways: google,
      events,
      actions,
      logger,
      windowDays: 30,
    });
    const mailbox = new MailboxService(repos, events);
    worker = new OutboxWorker({ repos, gateways: google, events, actions, logger, mailSync });
    tools = new ToolRegistry(actions).register(
      ...createEmailTools({
        repos,
        mailbox,
        gateways: google,
        events,
        search: new HybridSearch({ repos }),
      }),
    );

    const gmail = google.fakeGmail;
    gmail.labels.push({ id: 'Label_1', name: 'Invoices', type: 'user' });
    gmail.add(
      {
        id: 'm1',
        date: daysAgo(1),
        subject: 'Invoice March',
        from: 'Alice <alice@example.com>',
        body: 'Pay 100 USD',
      },
      false,
    );
    gmail.add({ id: 'm2', date: daysAgo(2), subject: 'Lunch?', labelIds: ['INBOX'] }, false);
    gmail.add({ id: 'm3', date: daysAgo(3), subject: 'Old thread', labelIds: ['Label_1'] }, false);
    gmail.add(
      {
        id: 'm4',
        date: daysAgo(4),
        subject: 'Sent by me',
        from: 'Me <me@example.com>',
        labelIds: ['SENT'],
      },
      false,
    );
    gmail.attach('m1', {
      partId: '1',
      attachmentId: 'att-1',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from('%PDF-1'),
    });
    await mailSync.sync(accountId);
  });

  it('describes every tool with a JSON schema', () => {
    const described = tools.describe();
    expect(described.map((d) => d.name).sort()).toEqual([
      'add_label',
      'add_todo',
      'archive',
      'create_label',
      'forward_email',
      'get_attachment',
      'get_email',
      'get_thread',
      'list_emails',
      'list_labels',
      'list_threads',
      'list_todos',
      'mark_read',
      'mark_unread',
      'move_to_inbox',
      'remove_label',
      'remove_todo',
      'reply_email',
      'search_emails',
      'send_email',
      'star',
      'unstar',
    ]);
    const send = described.find((d) => d.name === 'send_email')!;
    expect(send.sideEffect).toBe('outbound');
    expect(send.inputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['to', 'subject', 'body']),
    });
  });

  describe('read tools', () => {
    it('lists views with paging and label filters', async () => {
      const inbox = (await call('list_emails', { limit: 1 })) as {
        items: { id: string }[];
        nextCursor?: string;
      };
      expect(inbox.items.map((m) => m.id)).toEqual(['m1']);
      const next = (await call('list_emails', { limit: 5, cursor: inbox.nextCursor })) as {
        items: { id: string }[];
      };
      expect(next.items.map((m) => m.id)).toEqual(['m2']);
      const ids = async (input: object) =>
        ((await call('list_emails', input)) as { items: { id: string }[] }).items.map((m) => m.id);
      expect(await ids({ view: 'unread' })).toEqual(['m1']);
      expect(await ids({ view: 'archived' })).toEqual(['m3']);
      expect(await ids({ view: 'sent' })).toEqual(['m4']);
      expect(await ids({ view: 'all', label: 'invoices' })).toEqual(['m3']);
      await expect(call('list_emails', { label: 'Nope' })).rejects.toMatchObject({
        code: 'not_found',
        message: expect.stringContaining('Invoices'),
      });
    });

    it('lists conversations by view and query', async () => {
      const page = (await call('list_threads', { limit: 1 })) as {
        items: { threadId: string; messageIds: string[] }[];
        nextCursor?: string;
      };
      expect(page.items).toEqual([
        expect.objectContaining({ threadId: 't-m1', messageIds: ['m1'] }),
      ]);
      const next = (await call('list_threads', { cursor: page.nextCursor })) as {
        items: { threadId: string }[];
      };
      expect(next.items.map((t) => t.threadId)).toEqual(['t-m2']);
      const found = (await call('list_threads', { view: 'all', query: 'lunch' })) as {
        items: { subject: string }[];
      };
      expect(found.items.map((t) => t.subject)).toEqual(['Lunch?']);
    });

    it('searches and reads emails, threads, labels and attachments', async () => {
      const found = (await call('search_emails', { query: 'invoice' })) as {
        items: { id: string; matchedBy: string[] }[];
        mode: string;
      };
      expect(found.items.map((m) => m.id)).toEqual(['m1']);
      expect(found).toMatchObject({
        mode: 'keyword',
        note: expect.stringContaining('not configured'),
      });
      expect(found.items[0]!.matchedBy).toEqual(['keyword']);
      const email = (await call('get_email', { messageId: 'm1' })) as Record<string, unknown>;
      expect(email).toMatchObject({
        subject: 'Invoice March',
        bodyText: 'Pay 100 USD',
        bodyHtml: undefined,
      });
      expect(email.attachments).toEqual([
        expect.objectContaining({ partId: '1', filename: 'invoice.pdf' }),
      ]);
      expect(await call('get_thread', { threadId: 't-m1' })).toMatchObject({
        messages: [{ id: 'm1' }],
      });
      expect(await call('get_attachment', { messageId: 'm1', partId: '1' })).toEqual({
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 6,
        contentBase64: b64('%PDF-1'),
      });
      const labels = (await call('list_labels')) as { id: string; total: number; unread: number }[];
      expect(labels.find((l) => l.id === 'INBOX')).toMatchObject({ total: 2, unread: 1 });
      await expect(call('get_email', { messageId: 'zzz' })).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('re-reads the message when a stored attachment id went stale', async () => {
      const gmail = google.fakeGmail;
      gmail.attachments.set('m1/att-fresh', gmail.attachments.get('m1/att-1')!);
      gmail.attachments.delete('m1/att-1');
      const part = gmail.messages.get('m1')!.message.payload!.parts![1]!;
      part.body = { ...part.body, attachmentId: 'att-fresh' };
      expect(await call('get_attachment', { messageId: 'm1', partId: '1' })).toMatchObject({
        size: 6,
      });
    });

    it('does not log reads', async () => {
      await call('list_emails');
      await call('get_email', { messageId: 'm1' });
      expect((await repos.actionLogs.query({ actor: 'user', limit: 10 })).items).toEqual([]);
    });
  });

  describe('write tools', () => {
    it('changes flags locally, pushes them to Gmail and logs each call', async () => {
      await call('mark_read', { messageIds: ['m1'] });
      await call('star', { messageIds: ['m1', 'm2'] });
      await call('archive', { messageIds: ['m2'] });
      expect(await labelsOf('m1')).toEqual(['INBOX', 'STARRED']);
      expect(await labelsOf('m2')).toEqual(['STARRED']);
      await call('unstar', { messageIds: ['m1'] });
      await call('mark_unread', { messageIds: ['m1'] });
      await call('move_to_inbox', { messageIds: ['m2'] });
      await worker.drain(ctx.accountId);
      expect(google.fakeGmail.labelsOf('m1')).toEqual(['INBOX', 'UNREAD']);
      expect(google.fakeGmail.labelsOf('m2')).toEqual(['INBOX', 'STARRED']);

      const { items } = await repos.actionLogs.query({ actor: 'user', limit: 10 });
      expect(items.map((e) => e.action).reverse()).toEqual([
        'mark_read',
        'star',
        'archive',
        'unstar',
        'mark_unread',
        'move_to_inbox',
      ]);
      expect(items.at(-2)).toMatchObject({
        targetIds: ['m1', 'm2'],
        status: 'success',
        params: { messageIds: ['m1', 'm2'] },
      });
    });

    it('rejects unknown messages and logs the failure', async () => {
      await expect(call('star', { messageIds: ['m1', 'nope'] })).rejects.toMatchObject({
        code: 'not_found',
        message: expect.stringContaining('nope'),
      });
      expect(await labelsOf('m1')).not.toContain('STARRED');
      const { items } = await repos.actionLogs.query({ limit: 1 });
      expect(items[0]).toMatchObject({ action: 'star', status: 'error' });
    });

    it('validates input', async () => {
      const err = await call('star', { messageIds: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err).toMatchObject({ code: 'invalid_input' });
      await expect(call('nope')).rejects.toMatchObject({ code: 'unknown_tool' });
    });

    it('creates labels idempotently and applies/removes them by name', async () => {
      const created = (await call('create_label', { name: 'Travel' })) as {
        label: { id: string };
        created: boolean;
      };
      expect(created.created).toBe(true);
      expect(await call('create_label', { name: 'travel' })).toMatchObject({
        created: false,
        label: { id: created.label.id },
      });
      await call('add_label', { messageIds: ['m1'], label: 'Travel' });
      await call('add_label', { messageIds: ['m1'], label: 'Label_1' });
      expect(await labelsOf('m1')).toEqual(expect.arrayContaining([created.label.id, 'Label_1']));
      await call('remove_label', { messageIds: ['m1'], label: 'travel' });
      expect(await labelsOf('m1')).not.toContain(created.label.id);
      await expect(
        call('add_label', { messageIds: ['m1'], label: 'STARRED' }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('adds todos (titled after the email) and removes them by message', async () => {
      const todo = (await call('add_todo', { messageId: 'm1', due: '2026-12-01' })) as {
        id: string;
        title: string;
        due: Date;
      };
      expect(todo).toMatchObject({ title: 'Invoice March', due: new Date('2026-12-01T00:00:00Z') });
      await worker.drain(ctx.accountId);
      expect(google.fakeTasks.tasks.size).toBe(1);
      expect(await call('list_todos')).toEqual([
        expect.objectContaining({
          id: todo.id,
          message: expect.objectContaining({ subject: 'Invoice March' }),
        }),
      ]);
      expect(await call('remove_todo', { messageId: 'm1' })).toEqual({ removed: 1 });
      await worker.drain(ctx.accountId);
      expect(google.fakeTasks.tasks.size).toBe(0);
      await expect(call('remove_todo', { messageId: 'm1' })).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(call('remove_todo', {})).rejects.toMatchObject({ code: 'invalid_input' });
    });
  });

  describe('outbound tools', () => {
    it('sends a new email with attachments; the log keeps no bodies or file contents', async () => {
      await call('send_email', {
        to: ['Ann <ann@example.com>'],
        bcc: ['boss@example.com'],
        subject: 'Hello',
        body: 'secret body text',
        attachments: [
          { filename: 'notes.txt', mimeType: 'text/plain', contentBase64: b64('hi there') },
        ],
      });
      const sent = await sentRaw();
      expect(sent?.threadId).toBeUndefined();
      expect(sent?.raw).toMatch(/^From: Me Myself <me@example\.com>$/m);
      expect(sent?.raw).toMatch(/^To: Ann <ann@example\.com>$/m);
      expect(sent?.raw).toMatch(/^Bcc: boss@example\.com$/m);
      expect(sent?.raw).toContain(b64('hi there'));
      const [entry] = (await repos.actionLogs.query({ action: 'send_email', limit: 1 })).items;
      expect(entry?.params).toEqual({
        to: ['Ann <ann@example.com>'],
        bcc: ['boss@example.com'],
        subject: 'Hello',
        body: '(16 chars)',
        attachments: ['notes.txt'],
      });
      await expect(
        call('send_email', { to: ['not-an-email'], subject: 's', body: 'b' }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('replies in the thread with threading headers and the quoted original', async () => {
      google.fakeGmail.messages
        .get('m1')!
        .message.payload!.headers!.push({ name: 'Message-ID', value: '<m1@mail>' });
      await mailSyncAgain();
      const result = await call('reply_email', {
        messageId: 'm1',
        body: 'Paid, thanks',
        replyAll: true,
      });
      expect(result).toEqual({ queued: true, to: ['alice@example.com'], cc: [] });
      const sent = await sentRaw();
      expect(sent?.threadId).toBe('t-m1');
      expect(sent?.raw).toMatch(/^Subject: Re: Invoice March$/m);
      expect(sent?.raw).toMatch(/^In-Reply-To: <m1@mail>$/m);
      expect(sent?.raw).toContain('> Pay 100 USD');
    });

    it('forwards with the original attachments', async () => {
      expect(
        await call('forward_email', { messageId: 'm1', to: ['bob@example.com'], body: 'FYI' }),
      ).toEqual({ queued: true, attachments: 1 });
      const sent = await sentRaw();
      expect(sent?.raw).toMatch(/^Subject: Fwd: Invoice March$/m);
      expect(sent?.raw).toContain('---------- Forwarded message ---------');
      expect(sent?.raw).toContain(b64('%PDF-1'));
    });
  });

  async function mailSyncAgain() {
    const events = new EventBus(logger);
    const actions = new ActionLogger(repos.actionLogs, logger);
    await new MailSync({
      repos,
      gateways: google,
      events,
      actions,
      logger,
      windowDays: 30,
    }).refreshMessages(ctx.accountId, ['m1']);
  }
});
