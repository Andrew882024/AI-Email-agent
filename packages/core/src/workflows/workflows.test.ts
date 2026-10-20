import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../../test/helpers/db.js';
import { FakeGateways } from '../../test/helpers/fake-google.js';
import { FakeEmbeddings, ScriptedLLM } from '../../test/helpers/fake-llm.js';
import { type AgentEvent, ChatAgent } from '../agent/agent.js';
import { ChatFileStore } from '../agent/files.js';
import { MemoryService } from '../agent/memory.js';
import { createPgRepositories } from '../db/pg/index.js';
import type { Repositories } from '../db/repositories.js';
import { EventBus } from '../events/event-bus.js';
import type { GenerateRequest } from '../llm/types.js';
import { ActionLogger } from '../logging/action-logger.js';
import { HybridSearch } from '../rag/hybrid-search.js';
import { EmailIndexer } from '../rag/indexer.js';
import { MailSync } from '../sync/mail-sync.js';
import { MailboxService } from '../sync/mailbox.js';
import { OutboxWorker } from '../sync/outbox-worker.js';
import { createEmailTools } from '../tools/email-tools.js';
import { ToolRegistry } from '../tools/registry.js';
import { type WorkflowSpec, WorkflowEngine } from './engine.js';
import { createWorkflowTools } from './tools.js';

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Classifier stand-in: decides each "### Email <id>" block with `decide(text)`. */
function classifier(decide: (text: string) => { match: boolean; confidence: number }) {
  return (request: GenerateRequest) => {
    const text = (request.messages[0]!.parts[0] as { text: string }).text;
    const blocks = text.split('### Email ').slice(1);
    return JSON.stringify({
      decisions: blocks.map((block) => {
        const id = block.slice(0, block.indexOf('\n'));
        const { match, confidence } = decide(block);
        // `confidence` is the stub's match probability; non-matches stay below 0.5.
        return {
          messageId: id,
          matchProbability: match ? confidence : Math.min(confidence, 0.4),
          reason: `decided ${id}`,
        };
      }),
    });
  };
}

describe.skipIf(!testDatabaseUrl)('workflows', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let accountId: string;
  let google: FakeGateways;
  let events: EventBus;
  let tools: ToolRegistry;
  let engine: WorkflowEngine;
  let worker: OutboxWorker;
  let mailSync: MailSync;
  let decide: (text: string) => { match: boolean; confidence: number };
  let llm: ScriptedLLM;
  const logger = pino({ level: 'silent' });
  const embeddings = new FakeEmbeddings();

  const invoiceRule = (over: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
    name: 'Invoices',
    type: 'label',
    mode: 'persistent',
    instruction: 'Label all invoices as Bills',
    criteria: 'Invoices and bills asking me to pay an amount; not marketing or newsletters.',
    keywords: ['invoice', 'amount due'],
    action: { labelName: 'Bills' },
    ...over,
  });
  const labelsOf = async (id: string) =>
    (await repos.messages.getById(accountId, id))?.labelIds ?? [];
  const classifyCalls = () => llm.of('generate').length;

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    await sql`truncate action_logs`.execute(t.db);
    accountId = (await repos.accounts.upsert({ email: 'me@example.com', googleSub: 's' })).id;
    google = new FakeGateways();
    events = new EventBus(logger);
    const actions = new ActionLogger(repos.actionLogs, logger);
    const gmail = google.fakeGmail;
    gmail.add(
      {
        id: 'inv1',
        subject: 'Invoice #100',
        body: 'Amount due: 40 USD',
        from: 'Acme Billing <billing@acme.com>',
        date: days(3),
      },
      false,
    );
    gmail.add(
      {
        id: 'inv2',
        subject: 'Your invoice is ready',
        body: 'Invoice 200, amount due 12 USD',
        from: 'Hosting <bills@host.io>',
        date: days(5),
      },
      false,
    );
    gmail.add(
      {
        id: 'news',
        subject: 'Weekly newsletter',
        body: 'Tips and news, no invoice here really',
        from: 'News <news@acme.com>',
        date: days(2),
      },
      false,
    );
    gmail.add(
      {
        id: 'lunch',
        subject: 'Lunch?',
        body: 'Noodles on Friday',
        from: 'Bob <bob@x.com>',
        date: days(1),
      },
      false,
    );
    gmail.add(
      {
        id: 'old',
        subject: 'Old invoice',
        body: 'Invoice from last year, amount due 9',
        from: 'Acme Billing <billing@acme.com>',
        date: days(300),
      },
      false,
    );
    gmail.add(
      {
        id: 'arch',
        subject: 'Invoice archived',
        body: 'invoice amount due',
        labelIds: [],
        date: days(4),
      },
      false,
    );
    mailSync = new MailSync({ repos, gateways: google, events, actions, logger, windowDays: 3650 });
    await mailSync.sync(accountId);
    await new EmailIndexer({ repos, embeddings, events, logger }).indexAll(accountId);
    worker = new OutboxWorker({ repos, gateways: google, events, actions, logger, mailSync });

    decide = (text) =>
      /amount due/i.test(text) && /invoice/i.test(text)
        ? { match: true, confidence: 0.9 }
        : { match: false, confidence: 0.1 };
    llm = new ScriptedLLM((request) => classifier(decide)(request));
    tools = new ToolRegistry(actions).register(
      ...createEmailTools({
        repos,
        mailbox: new MailboxService(repos, events),
        gateways: google,
        events,
        search: new HybridSearch({ repos, embeddings }),
      }),
    );
    engine = new WorkflowEngine({ repos, llm, embeddings, tools, events, logger });
    tools.register(...createWorkflowTools(engine, repos));
  });

  it('previews without changing anything, then applies on approval and logs as the workflow', async () => {
    const preview = await engine.create(accountId, invoiceRule());
    expect(preview).toMatchObject({ name: 'Invoices', matches: 4 });
    expect(preview.candidates).toBeGreaterThanOrEqual(4);
    expect(preview.examples.map((e) => e.messageId).sort()).toEqual([
      'arch',
      'inv1',
      'inv2',
      'old',
    ]);
    expect(preview.examples[0]).toMatchObject({
      confidence: 0.9,
      reason: expect.stringMatching(/^decided /),
    });
    expect((await repos.workflows.get(preview.workflowId))?.status).toBe('awaiting_approval');
    expect(await labelsOf('inv1')).not.toContain('Label_9');
    expect(await repos.labels.findByName(accountId, 'Bills')).toBeUndefined();

    expect(await engine.apply(accountId, preview.workflowId)).toEqual({ applied: 4, failed: 0 });
    const bills = await repos.labels.findByName(accountId, 'Bills');
    expect(bills).toBeDefined();
    expect(await labelsOf('inv1')).toContain(bills!.id);
    expect(await labelsOf('news')).not.toContain(bills!.id);
    expect((await repos.workflows.get(preview.workflowId))?.status).toBe('active');
    expect(await repos.workflows.counts(preview.workflowId)).toMatchObject({ applied: 4 });
    const [log] = (await repos.actionLogs.query({ action: 'add_label', limit: 1 })).items;
    expect(log).toMatchObject({ actor: `workflow:${preview.workflowId}`, status: 'success' });
    await worker.drain(accountId);
    expect(google.fakeGmail.labelsOf('inv2')).toContain(bills!.id);
    await expect(engine.apply(accountId, preview.workflowId)).rejects.toThrow(
      'not awaiting approval',
    );
  });

  it('decides new inbox mail as it arrives, once, while active', async () => {
    const { workflowId } = await engine.create(accountId, invoiceRule({ keywords: ['invoice'] }));
    await engine.apply(accountId, workflowId);
    const bills = (await repos.labels.findByName(accountId, 'Bills'))!;

    google.fakeGmail.add({
      id: 'new1',
      subject: 'Invoice #300',
      body: 'Amount due 99',
      date: new Date(),
    });
    google.fakeGmail.add({ id: 'new2', subject: 'Party', body: 'Saturday?', date: new Date() });
    google.fakeGmail.add({
      id: 'sent1',
      subject: 'Invoice I sent',
      body: 'amount due',
      labelIds: ['SENT'],
      date: new Date(),
    });
    google.fakeGmail.add({
      id: 'self1',
      subject: 'Invoice to myself',
      body: 'amount due 3',
      labelIds: ['INBOX', 'SENT'],
      date: new Date(),
    });
    await mailSync.sync(accountId);
    const before = classifyCalls();
    await engine.handleNewMail(accountId, ['new1', 'new2', 'sent1', 'self1']);
    expect(classifyCalls()).toBe(before + 1);
    expect(await labelsOf('new1')).toContain(bills.id);
    expect(await labelsOf('new2')).not.toContain(bills.id);
    expect(await repos.workflows.getDecision(workflowId, 'new2')).toMatchObject({
      phase: 'incremental',
      status: 'skipped',
    });
    expect(await repos.workflows.getDecision(workflowId, 'sent1')).toBeUndefined();
    expect(await labelsOf('self1')).toContain(bills.id); // sent to myself, so it is in my inbox

    await engine.handleNewMail(accountId, ['new1', 'new2']);
    expect(classifyCalls()).toBe(before + 1); // already decided

    await engine.setPaused(accountId, workflowId, true);
    google.fakeGmail.add({
      id: 'new3',
      subject: 'Invoice #400',
      body: 'amount due 5',
      date: new Date(),
    });
    await mailSync.sync(accountId);
    await engine.handleNewMail(accountId, ['new3']);
    expect(await labelsOf('new3')).not.toContain(bills.id);
    await engine.setPaused(accountId, workflowId, false);
    await engine.enqueue(accountId, ['new3']);
    expect(await labelsOf('new3')).toContain(bills.id);
  });

  it('runs one-shot workflows once and leaves new mail alone', async () => {
    const { workflowId } = await engine.create(
      accountId,
      invoiceRule({ mode: 'one_shot', type: 'star_read', action: { star: true, markRead: true } }),
    );
    await engine.apply(accountId, workflowId);
    expect(await repos.messages.getById(accountId, 'inv1')).toMatchObject({
      isStarred: true,
      isRead: true,
    });
    expect((await repos.workflows.get(workflowId))?.status).toBe('completed');
    google.fakeGmail.add({
      id: 'new1',
      subject: 'Invoice',
      body: 'amount due 1',
      date: new Date(),
    });
    await mailSync.sync(accountId);
    await engine.handleNewMail(accountId, ['new1']);
    expect((await repos.messages.getById(accountId, 'new1'))?.isStarred).toBe(false);
  });

  it('archives only inbox mail and only above the stricter threshold', async () => {
    decide = (text) =>
      /inv1|inv2/.test(text.slice(0, 5))
        ? { match: true, confidence: text.startsWith('inv1') ? 0.9 : 0.8 }
        : { match: false, confidence: 0.1 };
    const preview = await engine.create(accountId, invoiceRule({ type: 'archive', action: {} }));
    expect(preview.matches).toBe(1); // inv2 at 0.8 is below the 0.85 archive threshold
    expect(preview.nearMisses.map((n) => n.messageId)).toContain('inv2');
    const decided = (await repos.workflows.decisions(preview.workflowId)).map((d) => d.messageId);
    expect(decided).not.toContain('arch'); // already out of the inbox
    await engine.apply(accountId, preview.workflowId);
    expect((await repos.messages.getById(accountId, 'inv1'))?.inInbox).toBe(false);
    expect((await repos.messages.getById(accountId, 'inv2'))?.inInbox).toBe(true);

    await engine.undo(accountId, preview.workflowId, 'inv1');
    expect((await repos.messages.getById(accountId, 'inv1'))?.inInbox).toBe(true);
    expect(await repos.workflows.getDecision(preview.workflowId, 'inv1')).toMatchObject({
      status: 'undone',
    });
    await expect(engine.undo(accountId, preview.workflowId, 'inv1')).rejects.toThrow(
      'Nothing to undo',
    );
  });

  it('considers every email of a sender for sender rules, honors `since`, and creates todos', async () => {
    decide = () => ({ match: true, confidence: 0.95 });
    const preview = await engine.create(
      accountId,
      invoiceRule({
        type: 'todo',
        action: { todoTitle: 'Pay Acme' },
        keywords: [],
        senderFilter: 'acme.com',
        since: days(30),
      }),
    );
    expect(preview.examples.map((e) => e.messageId).sort()).toEqual(['inv1', 'news']); // not "old" (before since)
    await engine.apply(accountId, preview.workflowId);
    expect((await repos.todos.list(accountId)).map((t) => [t.messageId, t.title]).sort()).toEqual([
      ['inv1', 'Pay Acme'],
      ['news', 'Pay Acme'],
    ]);
    await engine.undo(accountId, preview.workflowId, 'news');
    expect((await repos.todos.list(accountId)).map((t) => t.messageId)).toEqual(['inv1']);
  });

  it('marks the workflow failed when classification fails, and validates specs', async () => {
    llm = new ScriptedLLM(() => 'not json');
    engine = new WorkflowEngine({ repos, llm, embeddings, tools, events, logger });
    await expect(engine.create(accountId, invoiceRule())).rejects.toThrow('not JSON');
    const [failed] = await repos.workflows.list(accountId);
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('not JSON') });
    await expect(engine.create(accountId, invoiceRule({ action: {} }))).rejects.toThrow(
      'labelName',
    );
    await expect(
      engine.create(accountId, invoiceRule({ type: 'star_read', action: {} })),
    ).rejects.toThrow('star');
  });

  it('is driven by tools: the assistant must get approval to apply', async () => {
    const preview = (await tools.invoke(
      'create_workflow',
      { accountId, actor: 'user' },
      invoiceRule(),
    )) as { workflowId: string; matches: number };
    expect(
      await tools.approvalText(
        'apply_workflow',
        { accountId, actor: 'user' },
        { workflowId: preview.workflowId },
      ),
    ).toBe('apply workflow "Invoices" to 4 emails, and keep doing it for new mail');
    const listed = (await tools.invoke('list_workflows', { accountId, actor: 'user' }, {})) as {
      counts: Record<string, number>;
    }[];
    expect(listed[0]!.counts).toMatchObject({ pending: 4 });

    // Through the chat agent: apply_workflow always waits for the user.
    const turns: (() => unknown)[] = [
      () => [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'apply_workflow',
          args: { workflowId: preview.workflowId },
        },
      ],
      () => 'Applied.',
    ];
    const chatLlm = new ScriptedLLM((_r, kind) =>
      kind === 'generate' ? '{"operations":[]}' : (turns.shift()!() as never),
    );
    const actions = new ActionLogger(repos.actionLogs, logger);
    const agent = new ChatAgent({
      repos,
      llm: chatLlm,
      tools,
      files: new ChatFileStore(repos.chatFiles, '/tmp'),
      memory: new MemoryService({ repos, llm: chatLlm, actions, logger }),
      logger,
    });
    const session = await repos.chats.createSession(accountId);
    const events: AgentEvent[] = [];
    await agent.send(accountId, session.id, { text: 'apply it' }, (e) => events.push(e));
    const approval = events.find((e) => e.type === 'approval_required') as Extract<
      AgentEvent,
      { type: 'approval_required' }
    >;
    expect(approval.description).toBe(
      'apply workflow "Invoices" to 4 emails, and keep doing it for new mail',
    );
    expect((await repos.workflows.get(preview.workflowId))?.status).toBe('awaiting_approval');
    await agent.resolve(accountId, session.id, approval.runId, true, () => {});
    expect((await repos.workflows.get(preview.workflowId))?.status).toBe('active');
    const detail = (await tools.invoke(
      'get_workflow',
      { accountId, actor: 'user' },
      { workflowId: preview.workflowId },
    )) as {
      decisions: { subject: string; status: string }[];
    };
    expect(detail.decisions.map((d) => d.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    await tools.invoke(
      'delete_workflow',
      { accountId, actor: 'user' },
      { workflowId: preview.workflowId },
    );
    expect(await repos.workflows.list(accountId)).toEqual([]);
  });
});
