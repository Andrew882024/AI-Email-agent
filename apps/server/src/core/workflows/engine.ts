import { z } from 'zod';
import type { MessageFilter, NewWorkflow, Repositories } from '../db/repositories.js';
import {
  type DocumentAction,
  type DocumentFormat,
  type Message,
  SystemLabel,
  type Workflow,
  type WorkflowDecision,
} from '../domain/types.js';
import type { EventBus } from '../events/event-bus.js';
import { mapLimit } from '../google/retry.js';
import { generateObject } from '../llm/structured.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/types.js';
import type { ActionLogger } from '../logging/action-logger.js';
import type { Logger } from '../logging/system-logger.js';
import { emailChunk } from '../rag/chunk.js';
import { gmailLink, NotFoundError } from '../sync/mailbox.js';
import { type ToolContext, ToolError, type ToolRegistry } from '../tools/registry.js';
import { documentColumns, type DocumentEntry, type DocumentSink } from './documents.js';

export type WorkflowSpec = Omit<NewWorkflow, 'accountId' | 'sessionId'>;

export interface WorkflowPreview {
  workflowId: string;
  name: string;
  /** Emails considered (recalled) in the first run. */
  candidates: number;
  /** Emails that will be changed once approved. */
  matches: number;
  examples: {
    messageId: string;
    threadId: string;
    subject: string;
    from?: string;
    date: string;
    confidence: number;
    reason: string;
    /** document workflows: the values extracted from the email, by field name. */
    values?: Record<string, string>;
  }[];
  /** document workflows: what will be created on approval. */
  document?: { format: DocumentFormat; title: string; columns: string[] };
  /** Close calls that will NOT be changed, so the rule can be tuned. */
  nearMisses: { messageId: string; subject: string; confidence: number; reason: string }[];
}

export interface WorkflowEngineOptions {
  repos: Repositories;
  llm: LLMProvider;
  embeddings?: EmbeddingProvider;
  tools: ToolRegistry;
  events: EventBus;
  logger: Logger;
  /** Where document workflows write; without it, document workflows are unavailable. */
  documents?: DocumentSink;
  /** Records document writes (mailbox changes are logged by the tools). */
  actions?: ActionLogger;
  /** Max emails recalled on the first run. */
  candidateLimit?: number;
  /** Emails per classification request. */
  batchSize?: number;
  /** Minimum confidence to act. Archiving hides mail from the inbox, so it asks for more. */
  thresholds?: { default: number; archive: number };
}

// One number, not "match + confidence": models read confidence as certainty in their own answer, so a
// sure "no" came back as confidence 1.0. A match probability can't be read two ways.
const Classification = z.object({
  decisions: z.array(
    z.object({
      messageId: z.string(),
      matchProbability: z
        .number()
        .min(0)
        .max(1)
        .describe('Probability that this email matches the rule'),
      reason: z.string().describe('One short sentence'),
    }),
  ),
});

export const DOCUMENT_NAMES: Record<DocumentFormat, string> = {
  sheet: 'Google Sheet',
  doc: 'Google Doc',
  pdf: 'PDF',
};

/** Semantic recall keeps hits within this distance of the best one (absolute scores vary by mailbox). */
const RECALL_WINDOW = 0.12;
const RECALL_MIN = 50;
const RECALL_MAX = 200;

function describeAction(w: Pick<Workflow, 'type' | 'action'>): string {
  switch (w.type) {
    case 'label':
      return `apply the label "${w.action.labelName}"`;
    case 'todo':
      return 'add it to the to-do list';
    case 'archive':
      return 'archive it (remove it from the inbox)';
    case 'star_read':
      return (
        [w.action.star && 'star it', w.action.markRead && 'mark it as read']
          .filter(Boolean)
          .join(' and ') || 'nothing'
      );
    case 'document':
      return `record it in the ${DOCUMENT_NAMES[w.action.document!.format]} "${w.action.document!.title}"`;
  }
}

/**
 * Turns a described rule into actions on mail: recall candidates (semantic + keyword search),
 * have the model decide each one, preview, then apply on approval. Persistent workflows then
 * decide every new inbox email as it arrives. Every action goes through the mailbox tools as
 * actor workflow:<id>, so it is logged and synced to Gmail like any other change.
 */
export class WorkflowEngine {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkflowEngineOptions) {}

  threshold(w: Pick<Workflow, 'type'>): number {
    const t = this.options.thresholds ?? { default: 0.7, archive: 0.85 };
    return w.type === 'archive' ? t.archive : t.default;
  }

  /** Create a workflow and run its first pass as a preview (nothing is changed yet). */
  async create(
    accountId: string,
    spec: WorkflowSpec,
    sessionId?: string,
  ): Promise<WorkflowPreview> {
    this.validate(spec);
    const workflow = await this.options.repos.workflows.create(
      { ...spec, accountId, sessionId },
      'previewing',
    );
    this.changed(workflow);
    try {
      return await this.preview(workflow);
    } catch (err) {
      await this.options.repos.workflows.setStatus(
        workflow.id,
        'failed',
        err instanceof Error ? err.message : String(err),
      );
      this.changed(workflow);
      throw err;
    }
  }

  private validate(spec: WorkflowSpec): void {
    if (spec.type === 'label' && !spec.action.labelName?.trim())
      throw new ToolError('invalid_input', 'A label workflow needs action.labelName');
    if (spec.type === 'star_read' && !spec.action.star && !spec.action.markRead) {
      throw new ToolError(
        'invalid_input',
        'A star_read workflow needs action.star and/or action.markRead',
      );
    }
    if (spec.type === 'document') {
      const doc = spec.action.document;
      if (!doc?.title.trim() || doc.fields.length === 0)
        throw new ToolError(
          'invalid_input',
          'A document workflow needs action.document with a format, a title and fields',
        );
      const names = doc.fields.map((f) => f.name.trim().toLowerCase());
      if (new Set(names).size !== names.length || names.includes(''))
        throw new ToolError('invalid_input', 'Document fields need distinct, non-empty names');
      if (!this.options.documents)
        throw new ToolError('invalid_input', 'Document workflows are not available');
    }
  }

  private sink(): DocumentSink {
    if (!this.options.documents)
      throw new ToolError('invalid_input', 'Document workflows are not available');
    return this.options.documents;
  }

  private async preview(workflow: Workflow): Promise<WorkflowPreview> {
    const { repos } = this.options;
    const candidates = await this.recall(workflow);
    const decisions = await this.classify(workflow, candidates);
    const threshold = this.threshold(workflow);
    const outputs = await this.extract(
      workflow,
      candidates,
      decisions.filter((d) => d.match && d.confidence >= threshold).map((d) => d.messageId),
    );
    await repos.workflows.recordDecisions(
      workflow.id,
      workflow.accountId,
      decisions.map((d) => ({
        ...d,
        phase: 'backfill',
        status: d.match && d.confidence >= threshold ? 'pending' : 'skipped',
        output: outputs.get(d.messageId),
      })),
    );
    await repos.workflows.setStatus(workflow.id, 'awaiting_approval');
    this.changed(workflow);

    const byId = new Map(candidates.map((m) => [m.id, m]));
    const doc = workflow.action.document;
    const matched = decisions
      .filter((d) => d.match && d.confidence >= threshold)
      .sort((a, b) => b.confidence - a.confidence);
    const near = decisions
      .filter((d) => d.confidence < threshold && d.confidence >= 0.3)
      .sort((a, b) => b.confidence - a.confidence);
    return {
      workflowId: workflow.id,
      name: workflow.name,
      candidates: candidates.length,
      matches: matched.length,
      examples: matched.slice(0, 8).map((d) => {
        const m = byId.get(d.messageId)!;
        return {
          messageId: m.id,
          threadId: m.threadId,
          subject: m.subject,
          from: m.from?.name || m.from?.email,
          date: m.internalDate.toISOString().slice(0, 10),
          confidence: d.confidence,
          reason: d.reason,
          ...(outputs.has(d.messageId) && { values: outputs.get(d.messageId) }),
        };
      }),
      ...(workflow.type === 'document' &&
        doc && {
          document: {
            format: doc.format,
            title: doc.title,
            columns: doc.format === 'sheet' ? documentColumns(doc) : doc.fields.map((f) => f.name),
          },
        }),
      nearMisses: near.slice(0, 3).map((d) => ({
        messageId: d.messageId,
        subject: byId.get(d.messageId)!.subject,
        confidence: d.confidence,
        reason: d.reason,
      })),
    };
  }

  /** Apply an approved preview. Persistent workflows then keep handling new mail. */
  async apply(accountId: string, workflowId: string): Promise<{ applied: number; failed: number }> {
    const { repos } = this.options;
    const workflow = await this.own(accountId, workflowId);
    if (workflow.status !== 'awaiting_approval')
      throw new ToolError('invalid_input', `Workflow is ${workflow.status}, not awaiting approval`);
    const pending = (
      await repos.workflows.decisions(workflow.id, { status: 'pending', limit: 5000 })
    ).map((d) => d.messageId);
    const result = await this.act(workflow, pending);
    await repos.workflows.setStatus(
      workflow.id,
      workflow.mode === 'persistent' ? 'active' : 'completed',
    );
    this.changed(workflow);
    return result;
  }

  /** New mail arrived: let every active rule decide on it (serialized; safe to call often). */
  enqueue(accountId: string, messageIds: string[]): Promise<void> {
    const run = this.queue.then(() => this.handleNewMail(accountId, messageIds));
    this.queue = run.catch((err: unknown) =>
      this.options.logger.error({ err, accountId }, 'workflow run on new mail failed'),
    );
    return run;
  }

  /** Resolves once queued new-mail work has finished. */
  async idle(): Promise<void> {
    await this.queue;
  }

  async handleNewMail(accountId: string, messageIds: string[]): Promise<void> {
    const { repos } = this.options;
    const active = (await repos.workflows.list(accountId, { status: 'active' })).filter(
      (w) => w.mode === 'persistent',
    );
    if (active.length === 0 || messageIds.length === 0) return;
    // Only mail that arrived in the inbox (mail the user sent to others never gets INBOX; mail they sent
    // themselves does, and counts), never drafts.
    const incoming = (await repos.messages.getByIds(accountId, messageIds)).filter(
      (m) => m.labelIds.includes(SystemLabel.INBOX) && !m.labelIds.includes(SystemLabel.DRAFT),
    );
    for (const workflow of active) {
      const decided = await repos.workflows.decided(
        workflow.id,
        incoming.map((m) => m.id),
      );
      const fresh = incoming.filter((m) => !decided.has(m.id) && this.passesFilters(workflow, m));
      if (fresh.length === 0) continue;
      const decisions = await this.classify(workflow, fresh);
      const threshold = this.threshold(workflow);
      const matched = decisions
        .filter((d) => d.match && d.confidence >= threshold)
        .map((d) => d.messageId);
      const outputs = await this.extract(workflow, fresh, matched);
      await repos.workflows.recordDecisions(
        workflow.id,
        accountId,
        decisions.map((d) => ({
          ...d,
          phase: 'incremental',
          status: matched.includes(d.messageId) ? 'pending' : 'skipped',
          output: outputs.get(d.messageId),
        })),
      );
      if (matched.length > 0) await this.act(workflow, matched);
      this.changed(workflow);
    }
  }

  /** Reverse one applied decision (remove the label, move back to the inbox, ...). */
  async undo(
    accountId: string,
    workflowId: string,
    messageId: string,
    actor: ToolContext['actor'] = 'user',
  ): Promise<void> {
    const { repos, tools } = this.options;
    const workflow = await this.own(accountId, workflowId);
    const decision = await repos.workflows.getDecision(workflow.id, messageId);
    if (!decision) throw new NotFoundError(`No decision for message ${messageId}`);
    if (decision.status !== 'applied')
      throw new ToolError('invalid_input', `Nothing to undo: the decision is ${decision.status}`);
    const ctx: ToolContext = { accountId, actor };
    const ids = { messageIds: [messageId] };
    switch (workflow.type) {
      case 'label':
        await tools.invoke('remove_label', ctx, { ...ids, label: workflow.action.labelName });
        break;
      case 'todo':
        await tools.invoke('remove_todo', ctx, { messageId }).catch((err: unknown) => {
          if (!(err instanceof ToolError && err.code === 'not_found')) throw err; // already removed
        });
        break;
      case 'archive':
        await tools.invoke('move_to_inbox', ctx, ids);
        break;
      case 'star_read':
        if (workflow.action.star) await tools.invoke('unstar', ctx, ids);
        if (workflow.action.markRead) await tools.invoke('mark_unread', ctx, ids);
        break;
      case 'document': {
        const doc = workflow.action.document!;
        if (!this.sink().canRemove(doc.format))
          throw new ToolError(
            'invalid_input',
            `Entries can't be removed from a ${DOCUMENT_NAMES[doc.format]} one by one; edit the document instead`,
          );
        const account = await repos.accounts.getById(accountId);
        await this.track(workflow, 'remove_document_entry', [messageId], () =>
          this.sink().remove(accountId, doc, gmailLink(account?.email ?? '', messageId)),
        );
        break;
      }
    }
    await repos.workflows.setDecisionStatus(workflow.id, [messageId], 'undone');
    this.changed(workflow);
  }

  async setPaused(accountId: string, workflowId: string, paused: boolean): Promise<Workflow> {
    const workflow = await this.own(accountId, workflowId);
    const allowed = paused ? workflow.status === 'active' : workflow.status === 'paused';
    if (!allowed)
      throw new ToolError(
        'invalid_input',
        `Can't ${paused ? 'pause' : 'resume'} a workflow that is ${workflow.status}`,
      );
    await this.options.repos.workflows.setStatus(workflow.id, paused ? 'paused' : 'active');
    this.changed(workflow);
    return { ...workflow, status: paused ? 'paused' : 'active' };
  }

  /**
   * Change which emails a persistent workflow matches. New mail is judged by the new criteria;
   * decisions already made stay (undo them one by one if needed).
   */
  async updateCriteria(
    accountId: string,
    workflowId: string,
    change: Partial<Pick<Workflow, 'criteria' | 'keywords'>>,
  ): Promise<Workflow> {
    const workflow = await this.own(accountId, workflowId);
    if (workflow.mode !== 'persistent' || !['active', 'paused'].includes(workflow.status))
      throw new ToolError(
        'invalid_input',
        `Only active or paused persistent workflows can be edited (this one is ${workflow.mode === 'persistent' ? workflow.status : 'one-time'})`,
      );
    const updated = { ...workflow, ...change };
    await this.options.repos.workflows.setCriteria(workflow.id, updated);
    this.changed(workflow);
    return updated;
  }

  /** Stop and forget a workflow. Changes it already made stay (undo them first if needed). */
  async remove(accountId: string, workflowId: string): Promise<void> {
    const workflow = await this.own(accountId, workflowId);
    await this.options.repos.workflows.delete(workflow.id);
    this.changed(workflow);
  }

  async own(accountId: string, workflowId: string): Promise<Workflow> {
    const workflow = await this.options.repos.workflows.get(workflowId);
    if (!workflow || workflow.accountId !== accountId)
      throw new NotFoundError(`Workflow ${workflowId} not found`);
    return workflow;
  }

  /** Base filter: what a workflow may touch at all. */
  private filter(workflow: Workflow, labelId?: string): MessageFilter {
    const excluded = [
      SystemLabel.TRASH,
      SystemLabel.SPAM,
      SystemLabel.SENT,
      SystemLabel.DRAFT,
      ...(labelId ? [labelId] : []),
    ];
    return {
      excludeLabelIds: excluded,
      ...(workflow.type === 'archive' && { labelIds: [SystemLabel.INBOX] }),
      from: workflow.senderFilter,
      receivedAfter: workflow.since,
    };
  }

  private passesFilters(workflow: Workflow, m: Message): boolean {
    if (workflow.since && m.internalDate < workflow.since) return false;
    if (workflow.senderFilter) {
      const needle = workflow.senderFilter.toLowerCase();
      const from = `${m.from?.name ?? ''} ${m.from?.email ?? ''}`.toLowerCase();
      if (!from.includes(needle)) return false;
    }
    return true;
  }

  /** Candidate emails for the first run: semantic + keyword recall (or every email from the sender). */
  private async recall(workflow: Workflow): Promise<Message[]> {
    const { repos, embeddings } = this.options;
    const limit = this.options.candidateLimit ?? 500;
    const label =
      workflow.type === 'label' && workflow.action.labelName
        ? await repos.labels.findByName(workflow.accountId, workflow.action.labelName)
        : undefined;
    const filter = this.filter(workflow, label?.id);
    const ids = new Set<string>();

    if (workflow.senderFilter) {
      // A sender rule is precise: consider all of that sender's mail, newest first.
      let cursor: string | undefined;
      do {
        const page = await repos.messages.list(workflow.accountId, {
          ...filter,
          limit: 200,
          cursor,
        });
        page.items.forEach((m) => ids.add(m.id));
        cursor = page.nextCursor;
      } while (cursor && ids.size < limit);
    } else {
      if (embeddings) {
        try {
          const [vector] = await embeddings.embed(
            [`${workflow.criteria}\n${workflow.keywords.join(', ')}`],
            'query',
          );
          const hits = await repos.vectors.search(
            workflow.accountId,
            vector!,
            filter,
            Math.min(limit, RECALL_MAX),
          );
          // Similar mail clusters near the best hit; the long tail is unrelated mail of the same mailbox.
          const floor = (hits[0]?.score ?? 0) - RECALL_WINDOW;
          hits
            .filter((h, i) => i < RECALL_MIN || h.score >= floor)
            .forEach((h) => ids.add(h.messageId));
        } catch (err) {
          this.options.logger.warn(
            { err, workflowId: workflow.id },
            'semantic recall failed; keywords only',
          );
        }
      }
      if (workflow.keywords.length > 0) {
        const query = workflow.keywords
          .map((k) => (/\s/.test(k) ? `"${k.replace(/"/g, '')}"` : k))
          .join(' OR ');
        for (const hit of await repos.messages.keywordSearch(
          workflow.accountId,
          query,
          filter,
          limit,
        ))
          ids.add(hit.messageId);
      }
    }
    return repos.messages.getByIds(workflow.accountId, [...ids].slice(0, limit));
  }

  /** The model decides each email against the rule, in batches. */
  private async classify(
    workflow: Workflow,
    messages: Message[],
  ): Promise<Pick<WorkflowDecision, 'messageId' | 'match' | 'confidence' | 'reason'>[]> {
    const size = this.options.batchSize ?? 15;
    const batches: Message[][] = [];
    for (let i = 0; i < messages.length; i += size) batches.push(messages.slice(i, i + size));
    const system = [
      'You decide which emails match a rule the user set up for their mailbox automation.',
      `The user's request: ${workflow.instruction}`,
      `Emails that match: ${workflow.criteria}`,
      ...(workflow.keywords.length
        ? [`Words that often appear in matching emails: ${workflow.keywords.join(', ')}`]
        : []),
      `Matching emails will be changed: ${describeAction(workflow)}.`,
      '',
      'Decide every email in the list. Be precise: the email must mainly be about what the rule describes. A',
      'matching keyword alone is not enough, and newsletters, ads or digests that merely mention the topic do not',
      'match unless the rule asks for them. Give matchProbability: the probability (0 to 1) that the email',
      'matches; use low values when it clearly does not. Keep each reason to one short sentence.',
    ].join('\n');

    const results = await mapLimit(batches, 3, async (batch) => {
      const text = batch
        .map((m) => `### Email ${m.id}\n${emailChunk(m).slice(0, 1500)}`)
        .join('\n\n');
      const out = await generateObject(
        this.options.llm,
        { system, temperature: 0, messages: [{ role: 'user', parts: [{ type: 'text', text }] }] },
        Classification,
      );
      const byId = new Map(out.decisions.map((d) => [d.messageId, d]));
      // Emails the model skipped count as non-matches rather than failing the batch.
      return batch.map((m) => {
        const d = byId.get(m.id);
        if (!d)
          return {
            messageId: m.id,
            match: false,
            confidence: 0,
            reason: 'The model gave no decision',
          };
        return {
          messageId: m.id,
          match: d.matchProbability >= 0.5,
          confidence: d.matchProbability,
          reason: d.reason,
        };
      });
    });
    return results.flat();
  }

  /** Perform the workflow's action on messages through the mailbox tools, as actor workflow:<id>. */
  private async act(
    workflow: Workflow,
    messageIds: string[],
  ): Promise<{ applied: number; failed: number }> {
    const { repos, tools } = this.options;
    if (messageIds.length === 0) return { applied: 0, failed: 0 };
    const ctx: ToolContext = { accountId: workflow.accountId, actor: `workflow:${workflow.id}` };
    const applied: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const run = async (ids: string[], fn: () => Promise<unknown>) => {
      try {
        await fn();
        applied.push(...ids);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failed.push(...ids.map((id) => ({ id, error })));
      }
    };
    const chunks: string[][] = [];
    for (let i = 0; i < messageIds.length; i += 1000) chunks.push(messageIds.slice(i, i + 1000));

    switch (workflow.type) {
      case 'label': {
        const { label } = (await tools.invoke('create_label', ctx, {
          name: workflow.action.labelName,
        })) as { label: { id: string } };
        for (const ids of chunks)
          await run(ids, () =>
            tools.invoke('add_label', ctx, { messageIds: ids, label: label.id }),
          );
        break;
      }
      case 'todo':
        for (const id of messageIds) {
          await run([id], () =>
            tools.invoke('add_todo', ctx, {
              messageId: id,
              ...(workflow.action.todoTitle && { title: workflow.action.todoTitle }),
            }),
          );
        }
        break;
      case 'archive':
        for (const ids of chunks)
          await run(ids, () => tools.invoke('archive', ctx, { messageIds: ids }));
        break;
      case 'star_read':
        for (const ids of chunks) {
          await run(ids, async () => {
            if (workflow.action.star) await tools.invoke('star', ctx, { messageIds: ids });
            if (workflow.action.markRead) await tools.invoke('mark_read', ctx, { messageIds: ids });
          });
        }
        break;
      case 'document':
        await run(messageIds, () => this.record(workflow, messageIds));
        break;
    }
    await repos.workflows.setDecisionStatus(workflow.id, applied, 'applied');
    for (const f of failed)
      await repos.workflows.setDecisionStatus(workflow.id, [f.id], 'failed', f.error);
    return { applied: applied.length, failed: failed.length };
  }

  /**
   * The model reads each matched email and fills in the document's fields. Keys are f1..fn rather
   * than the user's field names, which can be any text.
   */
  private async extract(
    workflow: Workflow,
    messages: Message[],
    matchedIds: string[],
  ): Promise<Map<string, Record<string, string>>> {
    const doc = workflow.action.document;
    const result = new Map<string, Record<string, string>>();
    if (workflow.type !== 'document' || !doc || matchedIds.length === 0) return result;
    const wanted = new Set(matchedIds);
    const matched = messages.filter((m) => wanted.has(m.id));
    const keys = doc.fields.map((_, i) => `f${i + 1}`);
    const Extraction = z.object({
      rows: z.array(
        z.object({
          messageId: z.string(),
          values: z.object(
            Object.fromEntries(
              doc.fields.map((f, i) => [
                keys[i]!,
                z.string().default('').describe(`${f.name}: ${f.description}`),
              ]),
            ),
          ),
        }),
      ),
    });
    const system = [
      'You fill in a document the user keeps about their emails, one entry per email.',
      `The user's request: ${workflow.instruction}`,
      'Fields:',
      ...doc.fields.map((f, i) => `- ${keys[i]} "${f.name}": ${f.description}`),
      '',
      'Fill in the fields for every email in the list. Copy codes, numbers, amounts and names exactly as written.',
      'Use "" when the email does not say. Write dates as YYYY-MM-DD (add HH:mm when a time is given) unless the',
      'field says otherwise. Keep values short unless the field asks for a summary.',
    ].join('\n');
    const size = 8;
    const batches: Message[][] = [];
    for (let i = 0; i < matched.length; i += size) batches.push(matched.slice(i, i + size));
    await mapLimit(batches, 3, async (batch) => {
      const text = batch
        .map((m) => `### Email ${m.id}\n${emailChunk(m).slice(0, 6000)}`)
        .join('\n\n');
      const out = await generateObject(
        this.options.llm,
        { system, temperature: 0, messages: [{ role: 'user', parts: [{ type: 'text', text }] }] },
        Extraction,
      );
      const byId = new Map(out.rows.map((r) => [r.messageId, r.values]));
      for (const m of batch) {
        const values = byId.get(m.id) ?? {};
        result.set(
          m.id,
          Object.fromEntries(doc.fields.map((f, i) => [f.name, (values[keys[i]!] ?? '').trim()])),
        );
      }
    });
    return result;
  }

  /** Write matched emails (oldest first) to the workflow's document, creating it on first use. */
  private async record(workflow: Workflow, messageIds: string[]): Promise<void> {
    const { repos } = this.options;
    const sink = this.sink();
    let doc = workflow.action.document!;
    if (!doc.documentId) {
      doc = await this.track(workflow, 'create_document', [], () =>
        sink.create(workflow.accountId, doc),
      );
      await this.saveDocument(workflow, doc);
    }
    const wanted = new Set(messageIds);
    const outputs = new Map(
      (await repos.workflows.decisions(workflow.id, { status: 'pending', limit: 5000 }))
        .filter((d) => wanted.has(d.messageId))
        .map((d) => [d.messageId, d.output ?? {}]),
    );
    const account = await repos.accounts.getById(workflow.accountId);
    const entries: DocumentEntry[] = (await repos.messages.getByIds(workflow.accountId, messageIds))
      .sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime())
      .map((m) => ({
        messageId: m.id,
        received: m.internalDate,
        subject: m.subject,
        from: m.from && (m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email),
        link: gmailLink(account?.email ?? '', m.id),
        values: outputs.get(m.id) ?? {},
      }));
    const current = doc;
    const updated = await this.track(
      workflow,
      'append_to_document',
      entries.map((e) => e.messageId),
      () => sink.append(workflow.accountId, current, entries),
    );
    if (updated !== current) await this.saveDocument(workflow, updated);
  }

  private async saveDocument(workflow: Workflow, document: DocumentAction): Promise<void> {
    workflow.action = { ...workflow.action, document };
    await this.options.repos.workflows.setAction(workflow.id, workflow.action);
  }

  /** Log a document write as the workflow (mailbox changes are logged by the tools themselves). */
  private track<T>(
    workflow: Workflow,
    action: string,
    targetIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const doc = workflow.action.document;
    return this.options.actions
      ? this.options.actions.track(
          {
            accountId: workflow.accountId,
            actor: `workflow:${workflow.id}`,
            action,
            targetIds,
            params: { format: doc?.format, title: doc?.title, documentId: doc?.documentId },
          },
          fn,
        )
      : fn();
  }

  private changed(workflow: Pick<Workflow, 'id' | 'accountId'>): void {
    this.options.events.emit('workflow.updated', {
      accountId: workflow.accountId,
      workflowId: workflow.id,
    });
  }
}
