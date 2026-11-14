import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from '../../../test/helpers/db.js';
import { FakeGateways } from '../../../test/helpers/fake-google.js';
import { FakeEmbeddings, ScriptedLLM } from '../../../test/helpers/fake-llm.js';
import { createPgRepositories } from '../db/pg/index.js';
import type { Repositories } from '../db/repositories.js';
import { EventBus } from '../events/event-bus.js';
import type { GenerateRequest, Part } from '../llm/types.js';
import { ActionLogger } from '../logging/action-logger.js';
import { HybridSearch } from '../rag/hybrid-search.js';
import { MailSync } from '../sync/mail-sync.js';
import { MailboxService } from '../sync/mailbox.js';
import { createEmailTools } from '../tools/email-tools.js';
import { ToolRegistry } from '../tools/registry.js';
import { type AgentEvent, ChatAgent, compactForModel, systemPrompt } from './agent.js';
import { ChatFileStore } from './files.js';
import { MEMORY_RULES, MemoryService } from './memory.js';

const call = (name: string, args: Record<string, unknown>, id = `c-${name}`): Part => ({
  type: 'tool_call',
  id,
  name,
  args,
  signature: 'sig',
});
const isJudge = (r: GenerateRequest) => r.system === MEMORY_RULES;
const lastParts = (r: GenerateRequest) => r.messages.at(-1)!.parts;

describe.skipIf(!testDatabaseUrl)('ChatAgent', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let accountId: string;
  let dir: string;
  let google: FakeGateways;
  let tools: ToolRegistry;
  let files: ChatFileStore;
  const logger = pino({ level: 'silent' });
  /** Agent turns answer from `turns` in order; the memory judge answers from `judge`. */
  let turns: ((r: GenerateRequest) => string | Part[])[];
  let judge: (r: GenerateRequest) => string;
  let llm: ScriptedLLM;

  const agent = (options: Partial<ConstructorParameters<typeof ChatAgent>[0]> = {}) => {
    llm = new ScriptedLLM((request, kind) => {
      if (kind === 'generate' && isJudge(request)) return judge(request);
      if (kind === 'generate') return 'SUMMARY: user asked about invoices';
      const next = turns.shift();
      if (!next) throw new Error('unexpected model turn');
      return next(request);
    });
    const actions = new ActionLogger(repos.actionLogs, logger);
    const memory = new MemoryService({
      repos,
      llm,
      embeddings: new FakeEmbeddings(),
      actions,
      logger,
    });
    return new ChatAgent({
      repos,
      llm,
      tools,
      files,
      memory,
      logger,
      timeZone: 'UTC',
      now: () => new Date('2026-10-19T12:00:00Z'),
      ...options,
    });
  };
  const run = async (fn: (emit: (e: AgentEvent) => void) => Promise<void>) => {
    const events: AgentEvent[] = [];
    await fn((e) => events.push(e));
    return events;
  };
  const say = (a: ChatAgent, sessionId: string, text: string, fileIds?: string[]) =>
    run((emit) => a.send(accountId, sessionId, { text, fileIds }, emit));
  const newSession = async () => (await repos.chats.createSession(accountId)).id;

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
    dir = await mkdtemp(join(tmpdir(), 'agent-files-'));
  });
  afterAll(async () => {
    await t?.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    await sql`truncate action_logs`.execute(t.db);
    accountId = (
      await repos.accounts.upsert({ email: 'me@example.com', googleSub: 's', displayName: 'Me' })
    ).id;
    google = new FakeGateways();
    const events = new EventBus(logger);
    const actions = new ActionLogger(repos.actionLogs, logger);
    google.fakeGmail.add(
      {
        id: 'inv',
        subject: 'Invoice 4521',
        from: 'Billing <billing@acme.com>',
        body: 'Amount due 40 USD',
        date: new Date('2026-10-01'),
      },
      false,
    );
    for (let i = 0; i < 25; i++)
      google.fakeGmail.add(
        { id: `n${i}`, subject: `Newsletter ${i}`, date: new Date('2026-09-01') },
        false,
      );
    await new MailSync({ repos, gateways: google, events, actions, logger, windowDays: 3650 }).sync(
      accountId,
    );
    tools = new ToolRegistry(actions).register(
      ...createEmailTools({
        repos,
        mailbox: new MailboxService(repos, events),
        gateways: google,
        events,
        search: new HybridSearch({ repos }),
      }),
    );
    files = new ChatFileStore(repos.chatFiles, dir);
    turns = [];
    judge = () => '{"operations":[]}';
  });

  it('answers, streams, stores the conversation and titles the session', async () => {
    const a = agent();
    const sessionId = await newSession();
    turns.push(() => 'Hello! How can I help?');
    const events = await say(a, sessionId, 'Hi there, what can you do?');
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Hello! How can I help?');
    expect(events.at(-1)).toEqual({ type: 'done', status: 'complete' });
    expect((await repos.chats.listMessages(sessionId)).map((m) => [m.role, m.parts])).toEqual([
      ['user', [{ type: 'text', text: 'Hi there, what can you do?' }]],
      ['model', [{ type: 'text', text: 'Hello! How can I help?' }]],
    ]);
    expect((await repos.chats.getSession(sessionId))?.title).toBe('Hi there, what can you do?');
    const request = llm.of('stream')[0]!;
    expect(request.system).toContain('The user is Me <me@example.com>');
    expect(request.system).toContain('Monday, October 19, 2026');
    expect(request.tools?.map((t) => t.name)).toContain('search_emails');
    expect(request.tools?.map((t) => t.name)).toContain('draft_email');
    expect(request.tools?.map((t) => t.name)).not.toContain('send_email');
  });

  it('calls tools as the assistant, feeds results back, and logs writes with its actor', async () => {
    const a = agent();
    const sessionId = await newSession();
    turns.push(() => [
      { type: 'text', text: 'Let me look.' },
      call('search_emails', { query: 'invoice' }),
    ]);
    turns.push((r) => {
      const result = lastParts(r)[0] as Extract<Part, { type: 'tool_result' }>;
      expect(result).toMatchObject({
        type: 'tool_result',
        id: 'c-search_emails',
        name: 'search_emails',
        isError: false,
      });
      expect(JSON.stringify(result.result)).toContain('Invoice 4521');
      // The call is replayed with its provider signature.
      expect(r.messages.at(-2)!.parts.at(-1)).toMatchObject({
        type: 'tool_call',
        signature: 'sig',
      });
      return [call('star', { messageIds: ['inv'] })];
    });
    turns.push(() => 'Found it: [Invoice 4521](#thread/t-inv), due 40 USD. I starred it.');
    const events = await say(a, sessionId, 'Find my invoice and star it');

    expect(
      events.filter((e) => e.type === 'tool_call').map((e) => (e as { name: string }).name),
    ).toEqual(['search_emails', 'star']);
    expect(
      events.filter((e) => e.type === 'tool_result').every((e) => (e as { ok: boolean }).ok),
    ).toBe(true);
    expect((await repos.messages.getById(accountId, 'inv'))?.isStarred).toBe(true);
    const [log] = (await repos.actionLogs.query({ action: 'star', limit: 1 })).items;
    expect(log).toMatchObject({
      actor: `agent:${sessionId}`,
      targetIds: ['inv'],
      status: 'success',
    });
  });

  it('returns tool errors to the model and never sends mail itself', async () => {
    const a = agent();
    const sessionId = await newSession();
    turns.push(() => [
      call('send_email', { to: ['x@y.com'], subject: 's', body: 'b' }),
      call('get_email', { messageId: 'missing' }),
    ]);
    turns.push((r) => {
      const [send, get] = lastParts(r) as Extract<Part, { type: 'tool_result' }>[];
      expect(send).toMatchObject({
        isError: true,
        result: { error: 'Tool send_email is not available' },
      });
      expect(get).toMatchObject({ isError: true, result: { error: 'Message missing not found' } });
      return 'Sorry, I can only draft emails.';
    });
    await say(a, sessionId, 'Send an email to x@y.com');
    expect(google.fakeGmail.sent).toEqual([]);
  });

  it('pauses bulk changes for approval, then continues the same turn', async () => {
    const a = agent();
    const sessionId = await newSession();
    const ids = Array.from({ length: 25 }, (_, i) => `n${i}`);
    turns.push(() => [call('archive', { messageIds: ids })]);
    const paused = await say(a, sessionId, 'Archive all newsletters');
    const approval = paused.find((e) => e.type === 'approval_required') as Extract<
      AgentEvent,
      { type: 'approval_required' }
    >;
    expect(approval).toMatchObject({ name: 'archive', description: 'archive on 25 emails' });
    expect(paused.at(-1)).toEqual({ type: 'done', status: 'awaiting_approval' });
    expect((await repos.messages.getById(accountId, 'n0'))?.inInbox).toBe(true);
    await expect(say(a, sessionId, 'hello?')).rejects.toThrow('Approve or reject');

    turns.push((r) => {
      expect(lastParts(r)[0]).toMatchObject({
        type: 'tool_result',
        name: 'archive',
        isError: false,
        result: { updated: 25 },
      });
      return 'Archived 25 newsletters.';
    });
    const resumed = await run((emit) =>
      a.resolve(accountId, sessionId, approval.runId, true, emit),
    );
    expect(resumed.map((e) => e.type)).toEqual(['tool_result', 'text', 'text', 'done']);
    expect((await repos.messages.getById(accountId, 'n0'))?.inInbox).toBe(false);
    expect((await repos.chats.getToolRun(approval.runId))?.status).toBe('done');
    await expect(
      run((emit) => a.resolve(accountId, sessionId, approval.runId, true, emit)),
    ).rejects.toThrow('already handled');
  });

  it('tells the model when the user declines', async () => {
    const a = agent();
    const sessionId = await newSession();
    turns.push(() => [
      call('mark_read', { messageIds: Array.from({ length: 21 }, (_, i) => `n${i}`) }),
    ]);
    const paused = await say(a, sessionId, 'Mark newsletters read');
    const runId = (paused.find((e) => e.type === 'approval_required') as { runId: string }).runId;
    turns.push((r) => {
      expect(lastParts(r)[0]).toMatchObject({
        isError: true,
        result: { error: 'The user declined this action.' },
      });
      return 'OK, I left them unread.';
    });
    await run((emit) => a.resolve(accountId, sessionId, runId, false, emit));
    expect((await repos.messages.getById(accountId, 'n0'))?.isRead).toBe(false);
  });

  it('drafts replies with recipients and subject filled in, for the user to send', async () => {
    const a = agent();
    const sessionId = await newSession();
    turns.push(() => [
      call('draft_email', { mode: 'reply', messageId: 'inv', body: 'Paid today, thanks.' }),
    ]);
    turns.push(() => 'I opened a draft reply for you.');
    const events = await say(a, sessionId, 'Draft a reply saying I paid');
    expect(events.find((e) => e.type === 'draft')).toEqual({
      type: 'draft',
      draft: {
        mode: 'reply',
        sourceMessageId: 'inv',
        to: ['billing@acme.com'],
        cc: [],
        subject: 'Re: Invoice 4521',
        body: 'Paid today, thanks.',
        replyPreview: 'Billing',
      },
    });
    expect(google.fakeGmail.sent).toEqual([]);
  });

  it('reads attached files: text extracted, images passed through', async () => {
    const a = agent();
    const sessionId = await newSession();
    const note = await files.save(accountId, {
      filename: 'todo.txt',
      mimeType: 'text/plain',
      data: Buffer.from('Pay invoice 4521'),
    });
    const image = await files.save(accountId, {
      filename: 'shot.png',
      mimeType: 'image/png',
      data: Buffer.from('png'),
    });
    turns.push((r) => {
      const parts = r.messages[0]!.parts;
      expect(parts).toEqual([
        { type: 'text', text: '[Attached file: todo.txt]\nPay invoice 4521' },
        { type: 'text', text: '[Attached file: shot.png]' },
        { type: 'file', mimeType: 'image/png', data: Buffer.from('png'), name: 'shot.png' },
        { type: 'text', text: 'What do these say?' },
      ]);
      return 'The note says to pay invoice 4521.';
    });
    await say(a, sessionId, 'What do these say?', [note.id, image.id]);
    const other = (await repos.accounts.upsert({ email: 'x@example.com', googleSub: 'x' })).id;
    await expect(
      a.send(other, sessionId, { text: 'hi', fileIds: [note.id] }, () => {}),
    ).rejects.toThrow('not found');
  });

  it("keeps sessions separate but shares memory across them, by the judge's rules", async () => {
    const a = agent();
    const s1 = await newSession();
    const s2 = await newSession();
    judge = (r) => {
      expect(r.messages[0]!.parts[0]).toMatchObject({
        text: expect.stringContaining('USER: Always answer me in Chinese'),
      });
      return JSON.stringify({
        operations: [
          {
            op: 'add',
            id: null,
            content: 'Prefers answers in Chinese.',
            category: 'preference',
            confidence: 0.95,
            reason: 'explicit',
          },
          {
            op: 'add',
            id: null,
            content: 'Maybe likes cats.',
            category: 'other',
            confidence: 0.3,
            reason: 'guess',
          },
        ],
      });
    };
    turns.push(() => '好的，以后用中文回答。');
    await say(a, s1, 'Always answer me in Chinese from now on');
    const memories = await repos.memory.list(accountId);
    expect(memories.map((m) => m.content)).toEqual(['Prefers answers in Chinese.']);
    const [log] = (await repos.actionLogs.query({ action: 'memory.add', limit: 1 })).items;
    expect(log).toMatchObject({
      actor: `agent:${s1}`,
      params: { content: 'Prefers answers in Chinese.' },
    });

    judge = (r) => {
      expect(r.messages[0]!.parts[0]).toMatchObject({
        text: expect.stringContaining(
          `[${memories[0]!.id}] (preference) Prefers answers in Chinese.`,
        ),
      });
      return JSON.stringify({
        operations: [
          {
            op: 'update',
            id: memories[0]!.id,
            content: 'Prefers answers in Chinese, with English terms kept.',
            category: null,
            confidence: 0.9,
            reason: 'refined',
          },
        ],
      });
    };
    turns.push((r) => {
      expect(r.system).toContain('- Prefers answers in Chinese.');
      expect(r.messages).toHaveLength(1); // session 2 doesn't see session 1's messages
      return '收到。';
    });
    await say(a, s2, 'Keep technical terms in English though');
    expect((await repos.memory.list(accountId)).map((m) => m.content)).toEqual([
      'Prefers answers in Chinese, with English terms kept.',
    ]);

    judge = () =>
      JSON.stringify({
        operations: [
          {
            op: 'delete',
            id: 'not-a-real-id',
            content: null,
            category: null,
            confidence: 1,
            reason: 'x',
          },
        ],
      });
    turns.push(() => 'ok');
    await say(a, s2, 'thanks');
    expect(await repos.memory.list(accountId)).toHaveLength(1);
  });

  it('folds old history into a rolling summary without splitting tool calls from results', async () => {
    const a = agent({ historyBudget: 2000 });
    const sessionId = await newSession();
    for (let i = 0; i < 6; i++) {
      turns.push(() => [call('search_emails', { query: `invoice ${i}` }, `c${i}`)]);
      turns.push(() => `Answer ${i} ${'x'.repeat(300)}`);
      await say(a, sessionId, `Question ${i} ${'y'.repeat(300)}`);
    }
    const session = (await repos.chats.getSession(sessionId))!;
    expect(session.summary).toBe('SUMMARY: user asked about invoices');
    const kept = await repos.chats.listMessages(sessionId, { afterId: session.summarizedThrough });
    expect(kept[0]).toMatchObject({ role: 'user', parts: [{ type: 'text' }] });
    expect(kept.length).toBeLessThan(24);

    turns.push((r) => {
      expect(r.system).toContain(
        'Summary of earlier parts of this conversation:\nSUMMARY: user asked about invoices',
      );
      expect(r.messages[0]).toMatchObject({ role: 'user' });
      return 'ok';
    });
    await say(a, sessionId, 'And now?');
  });

  it('answers without tools on its last step, so a turn never ends empty', async () => {
    const a = agent({ maxSteps: 3 });
    const sessionId = await newSession();
    for (let i = 0; i < 2; i++) turns.push(() => [call('list_labels', {}, `l${i}`)]);
    turns.push((r) => {
      expect(r.tools).toBeUndefined();
      expect(r.system).toContain('You have used all your tool calls');
      return [
        { type: 'text', text: 'Here is what I found so far.' },
        call('list_labels', {}, 'ignored'),
      ];
    });
    const events = await say(a, sessionId, 'loop forever');
    expect(events.at(-1)).toEqual({ type: 'done', status: 'step_limit' });
    expect((await repos.chats.listMessages(sessionId)).at(-1)!.parts).toEqual([
      { type: 'text', text: 'Here is what I found so far.' },
    ]);

    turns.push(() => [call('list_labels', {}, 'a')]);
    turns.push(() => [call('list_labels', {}, 'b')]);
    turns.push(() => []);
    const silent = await say(a, sessionId, 'again');
    const text = silent.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(text.join('')).toContain('ran out of steps');
  });

  it('builds prompts and compacts large tool results', () => {
    expect(
      compactForModel({ body: 'z'.repeat(7000), list: Array.from({ length: 110 }, (_, i) => i) }),
    ).toEqual({
      body: `${'z'.repeat(6000)}…(truncated)`,
      list: [...Array.from({ length: 100 }, (_, i) => i), '…10 more'],
    });
    const prompt = systemPrompt({
      account: {
        id: 'a',
        email: 'me@x.com',
        googleSub: 's',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      now: new Date('2026-10-19T12:00:00Z'),
      timeZone: 'America/Los_Angeles',
      memories: [],
    });
    expect(prompt).toContain('5:00 AM (America/Los_Angeles)');
    expect(prompt).not.toContain('long-term memory');
  });
});
