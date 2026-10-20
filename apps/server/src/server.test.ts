import {
  ActionLogger,
  type Account,
  AuthFlowError,
  createEmailTools,
  createPgRepositories,
  EventBus,
  type GoogleAuthProvider,
  MailboxService,
  MailSync,
  OutboxWorker,
  ReauthRequiredError,
  type Repositories,
  ToolRegistry,
} from '@ai-email/core';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from '../../../packages/core/test/helpers/db.js';
import { FakeGateways } from '../../../packages/core/test/helpers/fake-google.js';
import { buildServer } from './server.js';

const logger = pino({ level: 'silent' });
const ORIGIN = 'http://localhost:5173';

describe.skipIf(!testDatabaseUrl)('HTTP API', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let app: FastifyInstance;
  let google: FakeGateways;
  let events: EventBus;
  let account: Account;
  let worker: OutboxWorker;
  const scheduler = { syncNow: vi.fn() };
  const auth = {
    startAuth: vi.fn<GoogleAuthProvider['startAuth']>(),
    getClient: vi.fn(),
    isConnected: vi.fn(async () => true),
    invalidate: vi.fn(),
    revoke: vi.fn(async () => {}),
  };

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', ...headers } });
  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        host: '127.0.0.1:4317',
        ...(payload !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(payload !== undefined && { payload: JSON.stringify(payload) }),
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    await sql`truncate action_logs`.execute(t.db);
    vi.clearAllMocks();
    account = await repos.accounts.upsert({ email: 'me@example.com', googleSub: 's' });
    google = new FakeGateways();
    events = new EventBus(logger);
    const actions = new ActionLogger(repos.actionLogs, logger);
    const mailSync = new MailSync({
      repos,
      gateways: google,
      events,
      actions,
      logger,
      windowDays: 30,
    });
    worker = new OutboxWorker({ repos, gateways: google, events, actions, logger, mailSync });
    const mailbox = new MailboxService(repos, events);
    const tools = new ToolRegistry(actions).register(
      ...createEmailTools({ repos, mailbox, gateways: google, events }),
    );
    google.fakeGmail.add(
      { id: 'm1', subject: 'Hello there', date: new Date(Date.now() - 3600_000) },
      false,
    );
    google.fakeGmail.attach('m1', {
      partId: '1',
      attachmentId: 'a1',
      filename: 'page.html',
      mimeType: 'text/html',
      data: Buffer.from('<script>x</script>'),
    });
    google.fakeGmail.add(
      { id: 'm2', subject: 'Photo', date: new Date(Date.now() - 7200_000) },
      false,
    );
    google.fakeGmail.attach('m2', {
      partId: '1',
      attachmentId: 'a2',
      filename: 'cat.png',
      mimeType: 'image/png',
      data: Buffer.from('png'),
    });
    await mailSync.sync(account.id);
    app = await buildServer(
      { repos, auth, tools, events, scheduler, logger },
      { allowedOrigins: [ORIGIN], heartbeatMs: 50 },
    );
  });
  afterEach(() => app?.close());

  describe('request guards', () => {
    it('rejects non-loopback Host headers (DNS rebinding)', async () => {
      expect((await get('/api/health', { host: 'evil.example:4317' })).statusCode).toBe(403);
      expect((await get('/api/health', { host: 'localhost:4317' })).statusCode).toBe(200);
    });

    it('rejects foreign origins, allows listed and same origins with CORS', async () => {
      const evil = await post(
        '/api/tools/star',
        { messageIds: ['m1'] },
        { origin: 'https://evil.example' },
      );
      expect(evil.statusCode).toBe(403);
      expect((await repos.messages.getById(account.id, 'm1'))?.isStarred).toBe(false);

      const dev = await get('/api/health', { origin: ORIGIN });
      expect(dev.statusCode).toBe(200);
      expect(dev.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect((await get('/api/health', { origin: 'http://127.0.0.1:4317' })).statusCode).toBe(200);
    });

    it('refuses non-JSON bodies (cross-site simple form posts)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tools/star',
        headers: { host: '127.0.0.1:4317', 'content-type': 'text/plain' },
        payload: '{"messageIds":["m1"]}',
      });
      expect(res.statusCode).toBe(415);
    });
  });

  describe('mail', () => {
    it('lists, searches and reads messages', async () => {
      const list = await get('/api/messages?view=inbox&limit=1');
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({
        items: [{ id: 'm1', subject: 'Hello there' }],
        nextCursor: expect.any(String),
      });
      expect(
        (await get('/api/messages?q=photo')).json().items.map((m: { id: string }) => m.id),
      ).toEqual(['m2']);
      expect((await get('/api/messages/m1')).json()).toMatchObject({
        id: 'm1',
        attachments: [{ filename: 'page.html' }],
      });
      expect((await get('/api/threads/t-m1')).json()).toMatchObject({ messages: [{ id: 'm1' }] });
      expect((await get('/api/labels')).json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'INBOX', total: 2 })]),
      );
    });

    it('returns structured errors', async () => {
      expect((await get('/api/messages/nope')).json()).toEqual({
        error: { code: 'not_found', message: 'Message nope not found' },
      });
      const bad = await post('/api/tools/star', { messageIds: 'm1' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('invalid_input');
      expect((await post('/api/tools/explode', {})).statusCode).toBe(404);
    });

    it('serves attachments: images inline, everything else as a sandboxed download', async () => {
      const png = await get('/api/messages/m2/attachments/1');
      expect(png.headers['content-type']).toBe('image/png');
      expect(png.headers['content-disposition']).toBe("inline; filename*=UTF-8''cat.png");
      expect(png.body).toBe('png');
      const html = await get('/api/messages/m1/attachments/1');
      expect(html.headers['content-type']).toBe('application/octet-stream');
      expect(html.headers['content-disposition']).toMatch(/^attachment;/);
      expect(html.headers['content-security-policy']).toBe('sandbox');
    });

    it('runs write tools as the user, logs them, and maps reauth to 401', async () => {
      const res = await post('/api/tools/star', { messageIds: ['m1'] });
      expect(res.json()).toEqual({ result: { updated: 1 } });
      await worker.drain(account.id);
      expect(google.fakeGmail.labelsOf('m1')).toContain('STARRED');
      const logs = (await get('/api/logs?actor=user')).json();
      expect(logs.items).toEqual([
        expect.objectContaining({
          actor: 'user',
          action: 'star',
          targetIds: ['m1'],
          status: 'success',
        }),
      ]);

      google.failWith = new ReauthRequiredError(account.id, 'expired');
      const reauth = await get('/api/messages/m1/attachments/1');
      expect(reauth.statusCode).toBe(401);
      expect(reauth.json().error.code).toBe('reauth_required');
    });

    it('lists tools with JSON schemas', async () => {
      const tools = (await get('/api/tools')).json();
      expect(tools).toHaveLength(21);
      expect(tools.find((x: { name: string }) => x.name === 'reply_email')).toMatchObject({
        sideEffect: 'outbound',
        inputSchema: { type: 'object' },
      });
    });
  });

  describe('auth & sync', () => {
    it('reports status, signs in, and signs out', async () => {
      expect((await get('/api/auth/status')).json()).toEqual({
        account: { id: account.id, email: 'me@example.com' },
        connected: true,
      });
      auth.startAuth.mockResolvedValueOnce(account);
      expect((await post('/api/auth/login')).json()).toEqual({
        account: { id: account.id, email: 'me@example.com' },
      });
      expect(scheduler.syncNow).toHaveBeenCalled();
      auth.startAuth.mockRejectedValueOnce(
        new AuthFlowError('Google sign-in was not completed: access_denied'),
      );
      const denied = await post('/api/auth/login');
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe('auth_failed');
      expect((await post('/api/auth/logout')).statusCode).toBe(200);
      expect(auth.revoke).toHaveBeenCalledWith(account.id);
    });

    it('rejects a second concurrent sign-in', async () => {
      let finish!: (a: Account) => void;
      auth.startAuth.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const first = post('/api/auth/login');
      await vi.waitFor(() => expect(auth.startAuth).toHaveBeenCalled());
      expect((await post('/api/auth/login')).statusCode).toBe(409);
      finish(account);
      expect((await first).statusCode).toBe(200);
    });

    it('requires an account', async () => {
      await sql`truncate accounts cascade`.execute(t.db);
      expect((await get('/api/auth/status')).json()).toEqual({ account: null, connected: false });
      expect((await get('/api/messages')).json().error.code).toBe('not_connected');
    });

    it('exposes sync status and a manual sync trigger', async () => {
      expect((await get('/api/sync/status')).json()).toMatchObject({
        historyId: expect.any(String),
        outboxPending: 0,
      });
      await post('/api/sync/now');
      expect(scheduler.syncNow).toHaveBeenCalled();
    });

    it('streams events over SSE', async () => {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { origin: ORIGIN },
      });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      const reader = res.body!.getReader();
      events.emit('message.added', { accountId: account.id, messageIds: ['m9'] });
      let text = '';
      while (!text.includes('event: message.added'))
        text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain(`data: {"accountId":"${account.id}","messageIds":["m9"]}`);
      await reader.cancel();
    });
  });
});
