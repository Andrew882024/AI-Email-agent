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
import { DRIVE_FOLDER, GoogleDriveDocumentSink } from './documents.js';
import { type WorkflowSpec, WorkflowEngine } from './engine.js';
import { createWorkflowTools } from './tools.js';

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Extraction stand-in: fills f1, f2, ... of each "### Email <id>" block with `fill(text)`. */
function extractor(fill: (text: string) => string[]) {
  return (request: GenerateRequest) => {
    const text = (request.messages[0]!.parts[0] as { text: string }).text;
    return JSON.stringify({
      rows: text
        .split('### Email ')
        .slice(1)
        .map((block) => ({
          messageId: block.slice(0, block.indexOf('\n')),
          values: Object.fromEntries(fill(block).map((v, i) => [`f${i + 1}`, v])),
        })),
    });
  };
}

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
    llm = new ScriptedLLM((request) =>
      request.system?.startsWith('You fill in a document')
        ? extractor((text) => [
            /amount due:? (\d+)/i.exec(text)?.[1] ?? '',
            /invoice #?(\d+)/i.exec(text)?.[1] ?? '',
          ])(request)
        : classifier(decide)(request),
    );
    tools = new ToolRegistry(actions).register(
      ...createEmailTools({
        repos,
        mailbox: new MailboxService(repos, events),
        gateways: google,
        events,
        search: new HybridSearch({ repos, embeddings }),
      }),
    );
    engine = new WorkflowEngine({
      repos,
      llm,
      embeddings,
      tools,
      events,
      logger,
      actions,
      documents: new GoogleDriveDocumentSink(google),
    });
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

  it('judges new mail by edited criteria; only active or paused persistent workflows can be edited', async () => {
    const { workflowId } = await engine.create(accountId, invoiceRule());
    const ctx = { accountId, actor: 'user' } as const;
    await expect(
      tools.invoke('update_workflow', ctx, {
        workflowId,
        criteria: 'Receipts for things I bought.',
      }),
    ).rejects.toThrow('awaiting_approval');
    await engine.apply(accountId, workflowId);

    expect(
      await tools.invoke('update_workflow', ctx, {
        workflowId,
        criteria: 'Receipts for things I bought.',
        keywords: ['receipt'],
      }),
    ).toMatchObject({ criteria: 'Receipts for things I bought.', keywords: ['receipt'] });
    expect(await repos.workflows.get(workflowId)).toMatchObject({
      criteria: 'Receipts for things I bought.',
      keywords: ['receipt'],
      status: 'active',
    });
    expect(await repos.workflows.counts(workflowId)).toMatchObject({ applied: 4 }); // stay as they were

    google.fakeGmail.add({ id: 'new1', subject: 'Receipt', body: 'Thanks', date: new Date() });
    await mailSync.sync(accountId);
    await engine.handleNewMail(accountId, ['new1']);
    expect(llm.of('generate').at(-1)?.system).toContain(
      'Emails that match: Receipts for things I bought.',
    );

    const oneShot = await engine.create(accountId, invoiceRule({ mode: 'one_shot' }));
    await engine.apply(accountId, oneShot.workflowId);
    await expect(
      engine.updateCriteria(accountId, oneShot.workflowId, { keywords: [] }),
    ).rejects.toThrow('one-time');
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

  describe('document workflows', () => {
    const drive = () => google.fakeDocuments;
    const invoiceTable = (
      format: 'sheet' | 'doc' | 'pdf',
      over: Partial<WorkflowSpec> = {},
    ): WorkflowSpec =>
      invoiceRule({
        name: 'Invoice table',
        type: 'document',
        action: {
          document: {
            format,
            title: 'Invoices',
            fields: [
              { name: 'Amount', description: 'amount due, number only' },
              { name: 'Invoice #', description: 'invoice number' },
            ],
          },
        },
        ...over,
      });

    it('previews extracted rows, creates the Sheet on approval, appends new mail and undoes rows', async () => {
      const preview = await engine.create(accountId, invoiceTable('sheet'));
      expect(preview.document).toEqual({
        format: 'sheet',
        title: 'Invoices',
        columns: ['Received', 'Amount', 'Invoice #', 'Subject', 'From', 'Email'],
      });
      expect(preview.examples.find((e) => e.messageId === 'inv1')?.values).toEqual({
        Amount: '40',
        'Invoice #': '100',
      });
      expect(drive().files.size).toBe(0); // nothing created before approval
      expect(
        await tools.approvalText(
          'apply_workflow',
          { accountId, actor: 'user' },
          { workflowId: preview.workflowId },
        ),
      ).toBe(
        'apply workflow "Invoice table" to 4 emails (creates the Google Sheet "Invoices" in your Google Drive), and keep doing it for new mail',
      );

      const applied = (await tools.invoke(
        'apply_workflow',
        { accountId, actor: 'user' },
        { workflowId: preview.workflowId },
      )) as { applied: number; documentUrl: string };
      expect(applied.applied).toBe(4);
      const [folder] = drive().of('folder');
      const [sheet] = drive().of('spreadsheet');
      expect(folder?.name).toBe(DRIVE_FOLDER);
      expect(sheet).toMatchObject({ name: 'Invoices', parent: folder!.id, headerFormatted: true });
      expect(applied.documentUrl).toContain(sheet!.id);
      expect(sheet!.rows[0]).toEqual([
        'Received',
        'Amount',
        'Invoice #',
        'Subject',
        'From',
        'Email',
      ]);
      // Oldest first; links identify the email in the right account.
      expect(sheet!.rows.slice(1).map((r) => r[3])).toEqual([
        'Old invoice',
        'Your invoice is ready',
        'Invoice archived',
        'Invoice #100',
      ]);
      expect(sheet!.rows.at(-1)).toEqual([
        expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/),
        '40',
        '100',
        'Invoice #100',
        'Acme Billing <billing@acme.com>',
        'https://mail.google.com/mail/?authuser=me%40example.com#all/inv1',
      ]);
      const workflow = await repos.workflows.get(preview.workflowId);
      expect(workflow?.action.document).toMatchObject({
        documentId: sheet!.id,
        folderId: folder!.id,
      });
      const logs = (await repos.actionLogs.query({ limit: 50 })).items.filter((l) =>
        ['create_document', 'append_to_document'].includes(l.action),
      );
      expect(logs.map((l) => [l.action, l.actor, l.status]).sort()).toEqual([
        ['append_to_document', `workflow:${preview.workflowId}`, 'success'],
        ['create_document', `workflow:${preview.workflowId}`, 'success'],
      ]);

      google.fakeGmail.add({ id: 'new1', subject: 'Invoice #300', body: 'Amount due 99' });
      google.fakeGmail.add({ id: 'new2', subject: 'Party', body: 'Saturday?' });
      await mailSync.sync(accountId);
      await engine.handleNewMail(accountId, ['new1', 'new2']);
      expect(drive().of('spreadsheet')).toHaveLength(1); // same sheet
      expect(sheet!.rows).toHaveLength(6);
      expect(sheet!.rows.at(-1)!.slice(1, 4)).toEqual(['99', '300', 'Invoice #300']);

      await engine.undo(accountId, preview.workflowId, 'inv2');
      expect(sheet!.rows.map((r) => r[3])).not.toContain('Your invoice is ready');
      expect(sheet!.rows).toHaveLength(5);
      expect(await repos.workflows.getDecision(preview.workflowId, 'inv2')).toMatchObject({
        status: 'undone',
        output: { Amount: '12', 'Invoice #': '200' },
      });
    });

    it('keeps a PDF exported from a Google Doc up to date in the same file', async () => {
      const preview = await engine.create(accountId, invoiceTable('pdf'));
      await engine.apply(accountId, preview.workflowId);
      const [source] = drive().of('document');
      const [pdf] = drive().of('pdf');
      expect(source).toMatchObject({ name: 'Invoices (PDF source)', title: 'Invoices' });
      expect(source!.sections.map((x) => x.heading)).toEqual([
        'Old invoice',
        'Your invoice is ready',
        'Invoice archived',
        'Invoice #100',
      ]);
      expect(source!.sections[3]).toMatchObject({
        fields: expect.arrayContaining([{ label: 'Amount', value: '40' }]),
        link: { text: 'Open in Gmail', url: expect.stringContaining('#all/inv1') },
      });
      expect(pdf).toMatchObject({ name: 'Invoices.pdf', writes: 2 });
      expect(pdf!.content).toContain('Invoice #: 100');

      google.fakeGmail.add({ id: 'new1', subject: 'Invoice #300', body: 'Amount due 99' });
      await mailSync.sync(accountId);
      await engine.handleNewMail(accountId, ['new1']);
      expect(drive().of('pdf')).toHaveLength(1);
      expect(pdf).toMatchObject({ writes: 3, content: expect.stringContaining('Amount: 99') });

      // The user deleted the PDF: the next update writes a new one and remembers it.
      drive().files.delete(pdf!.id);
      google.fakeGmail.add({ id: 'new2', subject: 'Invoice #400', body: 'Amount due 5' });
      await mailSync.sync(accountId);
      await engine.handleNewMail(accountId, ['new2']);
      const [replaced] = drive().of('pdf');
      expect((await repos.workflows.get(preview.workflowId))?.action.document).toMatchObject({
        pdfFileId: replaced!.id,
        pdfUrl: expect.stringContaining(replaced!.id),
      });

      await expect(engine.undo(accountId, preview.workflowId, 'inv1')).rejects.toThrow(
        "can't be removed from a PDF",
      );
    });

    it('writes Google Docs, records failures, and validates document specs', async () => {
      drive().failures.appendSections = [new Error('Docs API has not been used in project')];
      const preview = await engine.create(accountId, invoiceTable('doc', { mode: 'one_shot' }));
      expect(await engine.apply(accountId, preview.workflowId)).toEqual({ applied: 0, failed: 4 });
      expect(await repos.workflows.getDecision(preview.workflowId, 'inv1')).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Docs API'),
      });

      const second = await engine.create(accountId, invoiceTable('doc', { name: 'Again' }));
      await engine.apply(accountId, second.workflowId);
      const docs = drive().of('document');
      expect(docs.at(-1)!.sections).toHaveLength(4);

      await expect(
        engine.create(
          accountId,
          invoiceRule({
            type: 'document',
            action: { document: { format: 'sheet', title: 'X', fields: [] } },
          }),
        ),
      ).rejects.toThrow('fields');
      await expect(
        engine.create(
          accountId,
          invoiceRule({
            type: 'document',
            action: {
              document: {
                format: 'sheet',
                title: 'X',
                fields: [
                  { name: 'A', description: 'a' },
                  { name: 'a', description: 'b' },
                ],
              },
            },
          }),
        ),
      ).rejects.toThrow('distinct');
      const without = new WorkflowEngine({ repos, llm, embeddings, tools, events, logger });
      await expect(without.create(accountId, invoiceTable('sheet'))).rejects.toThrow(
        'not available',
      );
    });
  });
});
