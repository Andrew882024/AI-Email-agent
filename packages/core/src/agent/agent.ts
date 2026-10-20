import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import type {
  Account,
  ChatMessage,
  ChatSession,
  MemoryItem,
  StoredPart,
  ToolRun,
} from '../domain/types.js';
import type { LLMMessage, LLMProvider, Part, ToolDeclaration } from '../llm/types.js';
import type { Logger } from '../logging/system-logger.js';
import { NotFoundError } from '../sync/mailbox.js';
import { forwardSubject, replyRecipients, replySubject } from '../tools/compose.js';
import { type ToolInfo, type ToolRegistry, ToolError } from '../tools/registry.js';
import type { ChatFileStore } from './files.js';
import type { MemoryService } from './memory.js';

/** Streamed to the client while the assistant works. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; runId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; runId: string; name: string; ok: boolean; summary: string }
  | {
      type: 'approval_required';
      runId: string;
      name: string;
      args: Record<string, unknown>;
      description: string;
    }
  | { type: 'draft'; draft: EmailDraft }
  | { type: 'done'; status: 'complete' | 'awaiting_approval' | 'step_limit' }
  | { type: 'error'; message: string };

/** A draft the UI opens in a compose window; the user sends it. */
export interface EmailDraft {
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
  sourceMessageId?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** Recipients of a reply, for display (the server computes the real ones when sending). */
  replyPreview?: string;
}

/** Tools the assistant never gets: it drafts mail for the user to send, and base64 files help nobody. */
const HIDDEN_TOOLS = new Set(['send_email', 'reply_email', 'forward_email', 'get_attachment']);

const DraftInput = z.object({
  mode: z.enum(['new', 'reply', 'replyAll', 'forward']).default('new'),
  messageId: z
    .string()
    .optional()
    .describe('The email being replied to or forwarded (required unless mode is new)'),
  to: z.array(z.string()).optional().describe('Recipients for new emails and forwards'),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional().describe('For new emails'),
  body: z.string().describe("Plain-text body written in the user's voice"),
});

const DRAFT_TOOL: ToolDeclaration = {
  name: 'draft_email',
  description:
    'Write an email for the user: opens a compose window pre-filled with your draft so they can edit and send it. ' +
    'You cannot send email yourself. For replies/forwards give messageId; recipients and subject are filled in.',
  parameters: z.toJSONSchema(DraftInput, { io: 'input' }),
};

export function systemPrompt(input: {
  account: Account;
  now: Date;
  timeZone: string;
  memories: MemoryItem[];
  summary?: string;
}): string {
  const { account, now, timeZone, memories, summary } = input;
  const date = now.toLocaleString('en-US', { timeZone, dateStyle: 'full', timeStyle: 'short' });
  return [
    `You are the email assistant inside the user's mail app. The user is ${account.displayName ?? account.email} <${account.email}>.`,
    `Now: ${date} (${timeZone}).`,
    '',
    'You work on a synced copy of their Gmail through tools: search and read mail, mark read/unread, star, label,',
    'archive or move to inbox, and manage todos (Google Tasks). You cannot send email; use draft_email to open a',
    'pre-filled compose window the user sends themselves. Never claim you sent something.',
    '',
    'How to work:',
    '- Answer from the mail, not from guesses: search_emails first (it understands meaning, not only keywords),',
    '  then read the relevant emails with get_email / get_thread before giving details.',
    '- search_emails ranks by relevance. For "latest"/"most recent" or "all from X", use list_emails or list_threads',
    '  with filters (view, label, from): they are newest first and page with cursor (limit up to 100).',
    '- To change many emails, collect their ids that way, then call the write tool once with all the ids.',
    '- Be efficient: when you need several independent lookups (e.g. reading three emails), request them all in',
    '  the same step instead of one per step. Stop looking once you can answer.',
    '- Cite the emails you rely on as Markdown links: [short description](#thread/<threadId>).',
    '- For changes to many emails, find them first and say what you will change. Changes to more than 20 emails',
    "  wait for the user's approval automatically.",
    '- Workflows: for standing rules ("from now on…", "always…") or bulk changes described in words ("archive all',
    '  promotional mail"), use a workflow instead of collecting ids yourself. 1) Write the rule: precise criteria for',
    "  which emails match and which don't, 3-10 keywords, the action; show it and ask the user to confirm or adjust.",
    '  Call create_workflow only after the user has confirmed the rule in a later message, never in the same turn',
    '  as their request (unless they explicitly said to go ahead without confirming).',
    '  2) create_workflow (persistent = also new mail; one_shot = one-time). 3) Show the preview: how many match,',
    '  a few examples and close calls. 4) apply_workflow; the user approves it in the app.',
    '- To keep a table, document or PDF of certain emails ("put my orders in a spreadsheet"), use a document',
    '  workflow: propose the fields to extract (name + what/format) and the format (Excel → sheet) along with the',
    '  rule, and confirm both. Received date, subject, sender and a Gmail link are added automatically. In the',
    '  preview, show a few extracted rows. After applying, give the link to the document.',
    '- Be concise. Reply in the language the user writes in.',
    ...(memories.length > 0
      ? [
          '',
          'What you know about the user (long-term memory):',
          ...memories.map((m) => `- ${m.content}`),
        ]
      : []),
    ...(summary ? ['', 'Summary of earlier parts of this conversation:', summary] : []),
  ].join('\n');
}

/** Bound what goes back to the model: long strings and arrays are cut. */
export function compactForModel(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > 6000 ? `${value.slice(0, 6000)}…(truncated)` : value;
  if (Array.isArray(value)) {
    // Matches the largest tool page (100), so a full page is never cut.
    const items = value.slice(0, 100).map((v) => compactForModel(v, depth + 1));
    return value.length > 100 ? [...items, `…${value.length - 100} more`] : items;
  }
  if (value && typeof value === 'object' && depth < 8) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, compactForModel(v, depth + 1)]),
    );
  }
  return value;
}

const summarize = (value: unknown) => {
  const text = JSON.stringify(value) ?? '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

const textOf = (parts: StoredPart[]) =>
  parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
const size = (m: ChatMessage) => JSON.stringify(m.parts).length;

export interface ChatAgentOptions {
  repos: Repositories;
  llm: LLMProvider;
  tools: ToolRegistry;
  files: ChatFileStore;
  memory: MemoryService;
  logger: Logger;
  /** Model calls per user message; the last one may not use tools, so a turn always ends with an answer. */
  maxSteps?: number;
  /** Writes touching more messages than this wait for the user's approval. */
  approvalThreshold?: number;
  /** Characters of history kept verbatim before older messages are summarized. */
  historyBudget?: number;
  timeZone?: string;
  now?: () => Date;
}

type Emit = (event: AgentEvent) => void;

/**
 * Runs chat turns: the model plans, calls mailbox tools (as actor agent:<session>), and answers.
 * Bulk writes pause the turn until the user approves; long histories get a rolling summary; after
 * each turn the memory judge updates the account's shared memory.
 */
export class ChatAgent {
  constructor(private readonly options: ChatAgentOptions) {}

  async send(
    accountId: string,
    sessionId: string,
    input: { text: string; fileIds?: string[] },
    emit: Emit,
    signal?: AbortSignal,
  ): Promise<void> {
    const { repos, files } = this.options;
    const session = await this.session(accountId, sessionId);
    if ((await repos.chats.awaitingToolRuns(sessionId)).length > 0) {
      throw new ToolError('invalid_input', 'Approve or reject the pending action first');
    }
    const parts: StoredPart[] = [];
    for (const id of input.fileIds ?? []) {
      const file = await files.get(id);
      if (!file || file.accountId !== accountId) throw new NotFoundError(`File ${id} not found`);
      parts.push({
        type: 'file_ref',
        fileId: file.id,
        name: file.filename,
        mimeType: file.mimeType,
      });
    }
    if (input.text.trim()) parts.push({ type: 'text', text: input.text });
    if (parts.length === 0) throw new ToolError('invalid_input', 'Empty message');

    const first = (await repos.chats.listMessages(sessionId)).length === 0;
    await repos.chats.appendMessage(sessionId, 'user', parts);
    if (first && session.title === 'New chat') {
      const title =
        input.text.trim().replace(/\s+/g, ' ').slice(0, 60) ||
        parts.find((p) => p.type === 'file_ref')?.name;
      if (title) await repos.chats.updateSession(sessionId, { title });
    }
    await this.runTurn(accountId, sessionId, input.text, emit, signal);
  }

  /** The user approved or rejected a paused action; finish it and continue the turn. */
  async resolve(
    accountId: string,
    sessionId: string,
    runId: string,
    approve: boolean,
    emit: Emit,
    signal?: AbortSignal,
  ): Promise<void> {
    const { repos } = this.options;
    await this.session(accountId, sessionId);
    const run = await repos.chats.getToolRun(runId);
    if (!run || run.sessionId !== sessionId) throw new NotFoundError(`Action ${runId} not found`);
    if (run.status !== 'awaiting_approval')
      throw new ToolError('invalid_input', 'This action was already handled');

    if (approve) {
      const outcome = await this.execute(accountId, sessionId, run.tool, run.input, emit);
      await repos.chats.resolveToolRun(run.id, {
        status: outcome.ok ? 'done' : 'error',
        result: outcome.result,
      });
      emit({
        type: 'tool_result',
        runId: run.id,
        name: run.tool,
        ok: outcome.ok,
        summary: summarize(outcome.result),
      });
    } else {
      await repos.chats.resolveToolRun(run.id, {
        status: 'rejected',
        result: { error: 'The user declined this action.' },
      });
      emit({
        type: 'tool_result',
        runId: run.id,
        name: run.tool,
        ok: false,
        summary: 'Declined by the user',
      });
    }
    const runs = await repos.chats.listToolRuns(run.messageId);
    if (runs.some((r) => r.status === 'awaiting_approval')) {
      emit({ type: 'done', status: 'awaiting_approval' });
      return;
    }
    await repos.chats.appendMessage(sessionId, 'user', this.resultParts(runs));
    const lastUserText = await this.lastUserText(sessionId);
    await this.runTurn(accountId, sessionId, lastUserText, emit, signal);
  }

  private async runTurn(
    accountId: string,
    sessionId: string,
    userText: string,
    emit: Emit,
    signal?: AbortSignal,
  ) {
    const { repos, llm, maxSteps = 20 } = this.options;
    const account = await repos.accounts.getById(accountId);
    if (!account) throw new NotFoundError('Account not found');
    const declarations = this.declarations();
    let answer = '';

    for (let step = 0; step < maxSteps; step++) {
      const session = await this.session(accountId, sessionId);
      // The last step runs without tools, so every turn ends with an answer.
      const final = step === maxSteps - 1;
      const system = systemPrompt({
        account,
        now: this.now(),
        timeZone: this.timeZone(),
        memories: await this.options.memory.relevant(accountId, userText),
        summary: session.summary,
      });
      const request = {
        system: final
          ? `${system}\n\nYou have used all your tool calls for this message. Answer now with what you found, ` +
            'say what is left undone, and suggest how the user can continue.'
          : system,
        messages: await this.history(session),
        tools: final ? undefined : declarations,
        signal,
      };
      let result;
      for await (const chunk of llm.stream(request)) {
        if (chunk.type === 'text') emit({ type: 'text', text: chunk.text });
        if (chunk.type === 'done') result = chunk.result;
      }
      if (!result) throw new Error('The model stream ended without a result');
      // Tool calls made anyway on the final step are ignored.
      const stored: StoredPart[] = result.parts.flatMap((p): StoredPart[] =>
        p.type === 'text' || (p.type === 'tool_call' && !final) ? [p] : [],
      );
      if (!textOf(stored).trim() && (final || stored.length === 0)) {
        const note = '(I ran out of steps before finishing. Ask me to continue.)';
        emit({ type: 'text', text: note });
        stored.push({ type: 'text', text: note });
      }
      const message = await repos.chats.appendMessage(sessionId, 'model', stored);
      answer = textOf(stored) || answer;

      const calls = final ? [] : result.toolCalls;
      if (calls.length === 0) {
        emit({ type: 'done', status: final ? 'step_limit' : 'complete' });
        await this.afterTurn(accountId, sessionId, userText, answer);
        return;
      }

      const runs = await this.handleCalls(accountId, sessionId, message.id, calls, emit);
      if (runs.some((r) => r.status === 'awaiting_approval')) {
        emit({ type: 'done', status: 'awaiting_approval' });
        return;
      }
      await repos.chats.appendMessage(sessionId, 'user', this.resultParts(runs));
    }
  }

  private async handleCalls(
    accountId: string,
    sessionId: string,
    messageId: string,
    calls: Extract<Part, { type: 'tool_call' }>[],
    emit: Emit,
  ): Promise<ToolRun[]> {
    const { repos, approvalThreshold = 20 } = this.options;
    const info = new Map(this.options.tools.describe().map((t) => [t.name, t]));
    const planned = [];
    for (const [position, call] of calls.entries()) {
      const tool = info.get(call.name);
      const count = Array.isArray(call.args.messageIds) ? call.args.messageIds.length : 0;
      const needsApproval =
        tool?.approval === 'always' || (tool?.sideEffect === 'write' && count > approvalThreshold);
      if (needsApproval) {
        const ctx = { accountId, actor: `agent:${sessionId}` as const };
        const description =
          (await this.options.tools.approvalText(call.name, ctx, call.args)) ??
          `${call.name.replace(/_/g, ' ')} on ${count} emails`;
        // The description is kept on the waiting run so the approval card survives a reload.
        planned.push({
          position,
          callId: call.id,
          tool: call.name,
          input: call.args,
          status: 'awaiting_approval' as const,
          result: { description },
        });
        continue;
      }
      const outcome = await this.execute(accountId, sessionId, call.name, call.args, emit);
      planned.push({
        position,
        callId: call.id,
        tool: call.name,
        input: call.args,
        status: outcome.ok ? ('done' as const) : ('error' as const),
        result: outcome.result,
      });
    }
    const runs = await repos.chats.createToolRuns(sessionId, messageId, planned);
    for (const run of runs) {
      emit({ type: 'tool_call', runId: run.id, name: run.tool, args: run.input });
      if (run.status === 'awaiting_approval') {
        const description =
          (run.result as { description?: string } | undefined)?.description ?? run.tool;
        emit({
          type: 'approval_required',
          runId: run.id,
          name: run.tool,
          args: run.input,
          description,
        });
      } else {
        emit({
          type: 'tool_result',
          runId: run.id,
          name: run.tool,
          ok: run.status === 'done',
          summary: summarize(run.result),
        });
      }
    }
    return runs;
  }

  /** Run one tool as the assistant. Failures are returned to the model, not thrown. */
  private async execute(
    accountId: string,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    emit: Emit,
  ): Promise<{ ok: boolean; result: unknown }> {
    try {
      if (name === 'draft_email') {
        const draft = await this.draft(accountId, DraftInput.parse(args));
        emit({ type: 'draft', draft });
        return {
          ok: true,
          result: { opened: true, note: 'The draft is open for the user to review and send.' },
        };
      }
      if (HIDDEN_TOOLS.has(name))
        throw new ToolError('unknown_tool', `Tool ${name} is not available`);
      const result = await this.options.tools.invoke(
        name,
        { accountId, actor: `agent:${sessionId}` },
        args,
      );
      return { ok: true, result: compactForModel(result) };
    } catch (err) {
      return { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async draft(accountId: string, input: z.output<typeof DraftInput>): Promise<EmailDraft> {
    const base = { to: input.to ?? [], cc: input.cc ?? [], body: input.body };
    if (input.mode === 'new') return { mode: 'new', ...base, subject: input.subject ?? '' };
    if (!input.messageId)
      throw new ToolError('invalid_input', 'messageId is required for replies and forwards');
    const [account, original] = await Promise.all([
      this.options.repos.accounts.getById(accountId),
      this.options.repos.messages.getById(accountId, input.messageId),
    ]);
    if (!account || !original) throw new NotFoundError(`Message ${input.messageId} not found`);
    if (input.mode === 'forward') {
      return {
        mode: 'forward',
        sourceMessageId: original.id,
        ...base,
        subject: forwardSubject(original.subject),
      };
    }
    const { to, cc } = replyRecipients(original, account.email, input.mode === 'replyAll');
    const preview = [...to, ...cc].map((a) => a.name || a.email).join(', ');
    return {
      mode: input.mode,
      sourceMessageId: original.id,
      to: to.map((a) => a.email),
      cc: cc.map((a) => a.email),
      subject: replySubject(original.subject),
      body: input.body,
      replyPreview: preview,
    };
  }

  private resultParts(runs: ToolRun[]): StoredPart[] {
    return runs.map((r) => ({
      type: 'tool_result',
      id: r.callId,
      name: r.tool,
      result: r.result ?? null,
      isError: r.status !== 'done',
    }));
  }

  private declarations(): ToolDeclaration[] {
    const visible: ToolInfo[] = this.options.tools
      .describe()
      .filter((t) => !HIDDEN_TOOLS.has(t.name));
    return [
      ...visible.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
      DRAFT_TOOL,
    ];
  }

  /** Messages after the rolling summary, as the model sees them (files materialized). */
  private async history(session: ChatSession): Promise<LLMMessage[]> {
    const messages = await this.options.repos.chats.listMessages(session.id, {
      afterId: session.summarizedThrough,
    });
    const out: LLMMessage[] = [];
    for (const m of messages) {
      const parts: Part[] = [];
      for (const p of m.parts) {
        if (p.type === 'file_ref') {
          const file = await this.options.files.get(p.fileId);
          parts.push(
            ...(file
              ? await this.options.files.toParts(file)
              : [{ type: 'text' as const, text: `[File ${p.name} is no longer available]` }]),
          );
        } else if (p.type === 'tool_result') {
          parts.push({ ...p, result: compactForModel(p.result) });
        } else {
          parts.push(p);
        }
      }
      out.push({ role: m.role, parts });
    }
    return out;
  }

  /** Background work after an answer (memory judge, history summary); awaited by idle(). */
  private readonly pending = new Set<Promise<unknown>>();

  /** Resolves once post-turn work has finished (call before shutting down). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async afterTurn(
    accountId: string,
    sessionId: string,
    userText: string,
    answer: string,
  ): Promise<void> {
    const work = Promise.all([
      this.options.memory
        .review(accountId, sessionId, { user: userText, assistant: answer })
        .catch((err: unknown) => {
          this.options.logger.warn({ err, sessionId }, 'memory review failed');
        }),
      this.compactHistory(sessionId).catch((err: unknown) => {
        this.options.logger.warn({ err, sessionId }, 'history summary failed');
      }),
    ]);
    this.pending.add(work);
    try {
      await work;
    } finally {
      this.pending.delete(work);
    }
  }

  /**
   * Rolling summary: when the verbatim history outgrows the budget, fold the older part into the
   * session summary. The cut is at a user text message, so tool calls stay next to their results.
   */
  async compactHistory(sessionId: string): Promise<boolean> {
    const { repos, llm, historyBudget = 60_000 } = this.options;
    const session = await repos.chats.getSession(sessionId);
    if (!session) return false;
    const messages = await repos.chats.listMessages(sessionId, {
      afterId: session.summarizedThrough,
    });
    if (messages.reduce((n, m) => n + size(m), 0) <= historyBudget) return false;

    // Keep roughly the newest third of the budget verbatim.
    let kept = 0;
    let cut = messages.length;
    for (let i = messages.length - 1; i > 0; i--) {
      kept += size(messages[i]!);
      const m = messages[i]!;
      if (m.role === 'user' && m.parts.some((p) => p.type === 'text')) cut = i;
      if (kept > historyBudget / 3 && cut < messages.length) break;
    }
    if (cut <= 0 || cut >= messages.length) return false;
    const folded = messages.slice(0, cut);
    const transcript = folded
      .map((m) => {
        const body = m.parts
          .map((p) =>
            p.type === 'text'
              ? p.text
              : p.type === 'tool_call'
                ? `[called ${p.name} ${summarize(p.args)}]`
                : p.type === 'tool_result'
                  ? `[${p.name} → ${summarize(p.result)}]`
                  : `[file ${p.name}]`,
          )
          .join('\n');
        return `${m.role.toUpperCase()}: ${body}`;
      })
      .join('\n\n');
    const result = await llm.generate({
      system:
        'Summarize this part of a conversation between a user and their email assistant so the assistant can continue ' +
        "it. Keep: the user's goals and decisions, facts found (with email thread ids), actions taken, open tasks. " +
        'Under 300 words. Write in the language of the conversation.',
      messages: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: [session.summary ? `Earlier summary:\n${session.summary}` : '', transcript]
                .filter(Boolean)
                .join('\n\n'),
            },
          ],
        },
      ],
      temperature: 0,
    });
    await repos.chats.updateSession(sessionId, {
      summary: result.text.trim(),
      summarizedThrough: folded.at(-1)!.id,
    });
    return true;
  }

  private async lastUserText(sessionId: string): Promise<string> {
    const messages = await this.options.repos.chats.listMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = textOf(messages[i]!.parts);
      if (messages[i]!.role === 'user' && text) return text;
    }
    return '';
  }

  private async session(accountId: string, sessionId: string): Promise<ChatSession> {
    const session = await this.options.repos.chats.getSession(sessionId);
    if (!session || session.accountId !== accountId)
      throw new NotFoundError(`Chat ${sessionId} not found`);
    return session;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timeZone(): string {
    return this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}
