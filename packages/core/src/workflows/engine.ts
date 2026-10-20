import { z } from 'zod';
import type { MessageFilter, NewWorkflow, Repositories } from '../db/repositories.js';
import {
  type Message,
  SystemLabel,
  type Workflow,
  type WorkflowDecision,
} from '../domain/types.js';
import type { EventBus } from '../events/event-bus.js';
import { mapLimit } from '../google/retry.js';
import { generateObject } from '../llm/structured.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/types.js';
import type { Logger } from '../logging/system-logger.js';
import { emailChunk } from '../rag/chunk.js';
import { NotFoundError } from '../sync/mailbox.js';
import { type ToolContext, ToolError, type ToolRegistry } from '../tools/registry.js';

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
  }[];
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
  }

  private async preview(workflow: Workflow): Promise<WorkflowPreview> {
    const { repos } = this.options;
    const candidates = await this.recall(workflow);
    const decisions = await this.classify(workflow, candidates);
    const threshold = this.threshold(workflow);
    await repos.workflows.recordDecisions(
      workflow.id,
      workflow.accountId,
      decisions.map((d) => ({
        ...d,
        phase: 'backfill',
        status: d.match && d.confidence >= threshold ? 'pending' : 'skipped',
      })),
    );
    await repos.workflows.setStatus(workflow.id, 'awaiting_approval');
    this.changed(workflow);

    const byId = new Map(candidates.map((m) => [m.id, m]));
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
        };
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
      await repos.workflows.recordDecisions(
        workflow.id,
        accountId,
        decisions.map((d) => ({
          ...d,
          phase: 'incremental',
          status: matched.includes(d.messageId) ? 'pending' : 'skipped',
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
    }
    await repos.workflows.setDecisionStatus(workflow.id, applied, 'applied');
    for (const f of failed)
      await repos.workflows.setDecisionStatus(workflow.id, [f.id], 'failed', f.error);
    return { applied: applied.length, failed: failed.length };
  }

  private changed(workflow: Pick<Workflow, 'id' | 'accountId'>): void {
    this.options.events.emit('workflow.updated', {
      accountId: workflow.accountId,
      workflowId: workflow.id,
    });
  }
}
