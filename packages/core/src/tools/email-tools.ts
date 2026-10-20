import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import { type Label, type Message, SystemLabel } from '../domain/types.js';
import type { EventBus } from '../events/event-bus.js';
import type { GatewayProvider } from '../google/gateways.js';
import type { HybridSearch } from '../rag/hybrid-search.js';
import { NotFoundError, type MailboxService } from '../sync/mailbox.js';
import { parseAddresses, parseGmailLabel, parseGmailMessage } from '../sync/parse-message.js';
import {
  buildMime,
  forwardBody,
  forwardSubject,
  type OutgoingAttachment,
  quoteForReply,
  replyRecipients,
  replyReferences,
  replySubject,
} from './compose.js';
import { defineTool, type ToolContext, ToolError } from './registry.js';

export interface EmailToolDeps {
  repos: Repositories;
  mailbox: MailboxService;
  gateways: GatewayProvider;
  events: EventBus;
  search: HybridSearch;
}

/** Gmail rejects messages over 25 MB; leave room for MIME encoding overhead. */
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

const VIEWS = {
  inbox: { labelIds: [SystemLabel.INBOX] },
  starred: { labelIds: [SystemLabel.STARRED] },
  unread: {
    labelIds: [SystemLabel.UNREAD],
    excludeLabelIds: [SystemLabel.TRASH, SystemLabel.SPAM],
  },
  sent: { labelIds: [SystemLabel.SENT] },
  drafts: { labelIds: [SystemLabel.DRAFT] },
  archived: {
    excludeLabelIds: [
      SystemLabel.INBOX,
      SystemLabel.TRASH,
      SystemLabel.SPAM,
      SystemLabel.DRAFT,
      SystemLabel.SENT,
    ],
  },
  all: { excludeLabelIds: [SystemLabel.TRASH, SystemLabel.SPAM] },
  trash: { labelIds: [SystemLabel.TRASH] },
  spam: { labelIds: [SystemLabel.SPAM] },
} satisfies Record<string, { labelIds?: string[]; excludeLabelIds?: string[] }>;

const view = z
  .enum(Object.keys(VIEWS) as [keyof typeof VIEWS, ...(keyof typeof VIEWS)[]])
  .describe(
    'Mailbox view: inbox, starred, unread, sent, drafts, archived (not in inbox), all, trash or spam',
  );
const messageIds = z.array(z.string().min(1)).min(1).max(1000).describe('Gmail message ids');
const addressList = z
  .array(z.string().min(3))
  .describe('Email addresses, optionally with a name: "Ann <ann@example.com>"');
const attachments = z
  .array(
    z.object({
      filename: z.string().min(1),
      mimeType: z.string().min(1),
      contentBase64: z.string().min(1),
    }),
  )
  .max(20)
  .describe('Files to attach (base64 content)');
const listing = {
  label: z.string().optional().describe('Also require this label (name or id)'),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional().describe('nextCursor from a previous page'),
};

function parseRecipients(values: string[] | undefined, field: string) {
  const parsed = (values ?? []).flatMap((v) => parseAddresses(v));
  const invalid = parsed.filter((a) => !z.email().safeParse(a.email).success);
  if (invalid.length > 0) {
    throw new ToolError(
      'invalid_input',
      `Invalid ${field} address: ${invalid.map((a) => a.email).join(', ')}`,
    );
  }
  return parsed;
}

function decodeAttachments(files: z.output<typeof attachments> | undefined): OutgoingAttachment[] {
  const decoded = (files ?? []).map((f) => ({
    filename: f.filename,
    contentType: f.mimeType,
    content: Buffer.from(f.contentBase64, 'base64'),
  }));
  checkSize(decoded);
  return decoded;
}

function checkSize(files: OutgoingAttachment[]): void {
  const total = files.reduce((sum, f) => sum + f.content.length, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new ToolError(
      'invalid_input',
      `Attachments total ${(total / 1e6).toFixed(1)} MB; the limit is 18 MB`,
    );
  }
}

/** What the action log records for outbound tools: body sizes and file names, not contents. */
function withoutContent(input: Record<string, unknown>): Record<string, unknown> {
  const logged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((key === 'body' || key === 'html') && typeof value === 'string')
      logged[key] = `(${value.length} chars)`;
    else if (key === 'attachments' && Array.isArray(value)) {
      logged[key] = value.map((f: { filename: string }) => f.filename);
    } else logged[key] = value;
  }
  return logged;
}

export function createEmailTools(deps: EmailToolDeps) {
  const { repos, mailbox, gateways, events, search } = deps;

  async function account(ctx: ToolContext) {
    const found = await repos.accounts.getById(ctx.accountId);
    if (!found) throw new NotFoundError(`Account ${ctx.accountId} not found`);
    return found;
  }

  async function message(ctx: ToolContext, id: string): Promise<Message> {
    const found = await repos.messages.getById(ctx.accountId, id);
    if (!found) throw new NotFoundError(`Message ${id} not found`);
    return found;
  }

  /** All ids must exist locally, so typos fail loudly instead of silently doing nothing. */
  async function requireMessages(ctx: ToolContext, ids: string[]): Promise<void> {
    const found = new Set((await repos.messages.getByIds(ctx.accountId, ids)).map((m) => m.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw new NotFoundError(`Messages not found: ${missing.join(', ')}`);
  }

  async function resolveLabel(ctx: ToolContext, nameOrId: string): Promise<Label> {
    const label =
      (await repos.labels.get(ctx.accountId, nameOrId)) ??
      (await repos.labels.findByName(ctx.accountId, nameOrId));
    if (!label) {
      const names = (await repos.labels.list(ctx.accountId))
        .filter((l) => l.type === 'user')
        .map((l) => l.name);
      throw new NotFoundError(
        `Label "${nameOrId}" not found. Existing labels: ${names.join(', ') || 'none'}`,
      );
    }
    return label;
  }

  async function userLabel(ctx: ToolContext, nameOrId: string): Promise<Label> {
    const label = await resolveLabel(ctx, nameOrId);
    if (label.type !== 'user') {
      throw new ToolError(
        'invalid_input',
        `"${label.name}" is a system label; use the dedicated tool (mark_read, star, archive, ...)`,
      );
    }
    return label;
  }

  async function listQuery(ctx: ToolContext, v: keyof typeof VIEWS, label?: string) {
    const base: { labelIds?: string[]; excludeLabelIds?: string[] } = VIEWS[v];
    const extra = label ? [(await resolveLabel(ctx, label)).id] : [];
    return {
      labelIds: [...(base.labelIds ?? []), ...extra],
      excludeLabelIds: base.excludeLabelIds,
    };
  }

  async function loadAttachment(ctx: ToolContext, msg: Message, partId: string) {
    const meta = msg.attachments.find((a) => a.partId === partId);
    if (!meta) throw new NotFoundError(`Message ${msg.id} has no attachment part ${partId}`);
    const gmail = await gateways.gmail(ctx.accountId);
    if (meta.attachmentId) {
      try {
        return { meta, content: await gmail.getAttachment(msg.id, meta.attachmentId) };
      } catch {
        // Gmail attachment ids can go stale; re-read the message for a fresh one below.
      }
    }
    const fresh = await gmail.getMessage(msg.id);
    const freshMeta =
      fresh && parseGmailMessage(fresh).attachments.find((a) => a.partId === partId);
    if (!freshMeta?.attachmentId)
      throw new NotFoundError(`Attachment ${partId} of ${msg.id} is no longer available`);
    return { meta, content: await gmail.getAttachment(msg.id, freshMeta.attachmentId) };
  }

  async function from(ctx: ToolContext) {
    const a = await account(ctx);
    return { email: a.email, ...(a.displayName && { name: a.displayName }) };
  }

  const relabel = (
    name: string,
    description: string,
    change: { add?: string[]; remove?: string[] },
  ) =>
    defineTool({
      name,
      description,
      sideEffect: 'write',
      input: z.object({ messageIds }),
      targets: (i) => i.messageIds,
      handler: async (ctx, i) => {
        await requireMessages(ctx, i.messageIds);
        await mailbox.modifyLabels(ctx.accountId, i.messageIds, change);
        return { updated: i.messageIds.length };
      },
    });

  return [
    // ---------- read ----------
    defineTool({
      name: 'list_emails',
      description:
        'List emails in a mailbox view (newest first), with paging. Returns summaries without bodies.',
      sideEffect: 'read',
      input: z.object({ view: view.default('inbox'), ...listing }),
      handler: async (ctx, i) =>
        repos.messages.list(ctx.accountId, {
          ...(await listQuery(ctx, i.view, i.label)),
          limit: i.limit,
          cursor: i.cursor,
        }),
    }),
    defineTool({
      name: 'list_threads',
      description:
        'List conversations in a mailbox view (newest first), optionally filtered by a keyword query. ' +
        'Each item summarizes the whole conversation and includes its messageIds.',
      sideEffect: 'read',
      input: z.object({
        view: view.default('inbox'),
        query: z.string().optional().describe('Keyword search, as in search_emails'),
        ...listing,
      }),
      handler: async (ctx, i) =>
        repos.messages.listThreads(ctx.accountId, {
          ...(await listQuery(ctx, i.view, i.label)),
          search: i.query,
          limit: i.limit,
          cursor: i.cursor,
        }),
    }),
    defineTool({
      name: 'search_emails',
      description:
        'Search emails by meaning and keywords (hybrid semantic + full-text search), most relevant first. ' +
        'Works for questions ("when is my flight?") and exact terms ("invoice 4521"). Returns summaries ' +
        'with a relevance score; use get_email or get_thread to read the bodies.',
      sideEffect: 'read',
      input: z.object({
        query: z.string().min(1),
        view: view.default('all'),
        label: z.string().optional().describe('Only emails with this label (name or id)'),
        from: z.string().optional().describe('Sender address or name contains this'),
        after: z.iso.date().optional().describe('Received on or after this date (YYYY-MM-DD)'),
        before: z.iso.date().optional().describe('Received before this date (YYYY-MM-DD)'),
        limit: z.number().int().min(1).max(50).default(10),
        mode: z
          .enum(['hybrid', 'keyword', 'semantic'])
          .default('hybrid')
          .describe('keyword = exact terms only; semantic = meaning only'),
      }),
      handler: async (ctx, i) =>
        search.search(
          ctx.accountId,
          i.query,
          {
            ...(await listQuery(ctx, i.view, i.label)),
            from: i.from,
            receivedAfter: i.after ? new Date(`${i.after}T00:00:00Z`) : undefined,
            receivedBefore: i.before ? new Date(`${i.before}T00:00:00Z`) : undefined,
          },
          i.limit,
          i.mode,
        ),
    }),
    defineTool({
      name: 'get_email',
      description:
        'Get one email with its plain-text body and attachment list. HTML only when includeHtml is true.',
      sideEffect: 'read',
      input: z.object({ messageId: z.string().min(1), includeHtml: z.boolean().default(false) }),
      handler: async (ctx, i) => {
        const msg = await message(ctx, i.messageId);
        return i.includeHtml ? msg : { ...msg, bodyHtml: undefined };
      },
    }),
    defineTool({
      name: 'get_thread',
      description: 'Get every email of a conversation, oldest first.',
      sideEffect: 'read',
      input: z.object({ threadId: z.string().min(1), includeHtml: z.boolean().default(false) }),
      handler: async (ctx, i) => {
        const msgs = await repos.messages.getThread(ctx.accountId, i.threadId);
        if (msgs.length === 0) throw new NotFoundError(`Thread ${i.threadId} not found`);
        return {
          threadId: i.threadId,
          messages: i.includeHtml ? msgs : msgs.map((m) => ({ ...m, bodyHtml: undefined })),
        };
      },
    }),
    defineTool({
      name: 'get_attachment',
      description: 'Download one attachment of an email (base64).',
      sideEffect: 'read',
      input: z.object({ messageId: z.string().min(1), partId: z.string().min(1) }),
      handler: async (ctx, i) => {
        const { meta, content } = await loadAttachment(
          ctx,
          await message(ctx, i.messageId),
          i.partId,
        );
        return {
          filename: meta.filename,
          mimeType: meta.mimeType,
          size: content.length,
          contentBase64: content.toString('base64'),
        };
      },
    }),
    defineTool({
      name: 'list_labels',
      description: 'List labels with total and unread counts.',
      sideEffect: 'read',
      input: z.object({}),
      handler: async (ctx) => {
        const [labels, counts] = await Promise.all([
          repos.labels.list(ctx.accountId),
          repos.messages.countByLabel(ctx.accountId),
        ]);
        return labels.map((l) => ({
          ...l,
          total: counts[l.id]?.total ?? 0,
          unread: counts[l.id]?.unread ?? 0,
        }));
      },
    }),
    defineTool({
      name: 'list_todos',
      description: 'List todos created from emails, with the email subject and sender.',
      sideEffect: 'read',
      input: z.object({ status: z.enum(['needsAction', 'completed']).optional() }),
      handler: async (ctx, i) => {
        const todos = await repos.todos.list(ctx.accountId, { status: i.status });
        const ids = [...new Set(todos.flatMap((t) => (t.messageId ? [t.messageId] : [])))];
        const byId = new Map(
          (await repos.messages.getByIds(ctx.accountId, ids)).map((m) => [m.id, m]),
        );
        return todos.map((t) => {
          const m = t.messageId ? byId.get(t.messageId) : undefined;
          return {
            ...t,
            message: m && { id: m.id, threadId: m.threadId, subject: m.subject, from: m.from },
          };
        });
      },
    }),

    // ---------- write ----------
    relabel('mark_read', 'Mark emails as read.', { remove: [SystemLabel.UNREAD] }),
    relabel('mark_unread', 'Mark emails as unread.', { add: [SystemLabel.UNREAD] }),
    relabel('star', 'Star emails.', { add: [SystemLabel.STARRED] }),
    relabel('unstar', 'Remove the star from emails.', { remove: [SystemLabel.STARRED] }),
    relabel('archive', 'Archive emails (remove them from the inbox; they stay in All Mail).', {
      remove: [SystemLabel.INBOX],
    }),
    relabel('move_to_inbox', 'Move archived emails back to the inbox.', {
      add: [SystemLabel.INBOX],
    }),
    defineTool({
      name: 'add_label',
      description:
        'Apply a user label (by name or id) to emails. The label must exist; see create_label.',
      sideEffect: 'write',
      input: z.object({ messageIds, label: z.string().min(1) }),
      targets: (i) => i.messageIds,
      handler: async (ctx, i) => {
        const label = await userLabel(ctx, i.label);
        await requireMessages(ctx, i.messageIds);
        await mailbox.modifyLabels(ctx.accountId, i.messageIds, { add: [label.id] });
        return { label, updated: i.messageIds.length };
      },
    }),
    defineTool({
      name: 'remove_label',
      description: 'Remove a user label (by name or id) from emails.',
      sideEffect: 'write',
      input: z.object({ messageIds, label: z.string().min(1) }),
      targets: (i) => i.messageIds,
      handler: async (ctx, i) => {
        const label = await userLabel(ctx, i.label);
        await requireMessages(ctx, i.messageIds);
        await mailbox.modifyLabels(ctx.accountId, i.messageIds, { remove: [label.id] });
        return { label, updated: i.messageIds.length };
      },
    }),
    defineTool({
      name: 'create_label',
      description:
        'Create a user label in Gmail (returns the existing one if the name is taken). Use "/" for nesting.',
      sideEffect: 'write',
      input: z.object({ name: z.string().trim().min(1).max(225) }),
      handler: async (ctx, i) => {
        const existing = await repos.labels.findByName(ctx.accountId, i.name);
        if (existing) return { label: existing, created: false };
        const label = parseGmailLabel(
          await (await gateways.gmail(ctx.accountId)).createLabel(i.name),
        );
        if (!label) throw new ToolError('internal', 'Gmail returned an invalid label');
        await repos.labels.upsert(ctx.accountId, [label]);
        events.emit('labels.changed', { accountId: ctx.accountId });
        return { label, created: true };
      },
    }),
    defineTool({
      name: 'add_todo',
      description:
        'Create a todo (a Google Task linking back to the email). Title defaults to the email subject.',
      sideEffect: 'write',
      input: z.object({
        messageId: z.string().min(1),
        title: z.string().trim().min(1).max(1024).optional(),
        notes: z.string().max(8000).optional(),
        due: z.iso.date().optional().describe('YYYY-MM-DD'),
      }),
      targets: (i) => [i.messageId],
      handler: async (ctx, i) => {
        const msg = await message(ctx, i.messageId);
        return mailbox.addTodo(ctx.accountId, {
          messageId: msg.id,
          title: i.title ?? (msg.subject || '(no subject)'),
          notes: i.notes,
          due: i.due ? new Date(`${i.due}T00:00:00Z`) : undefined,
        });
      },
    }),
    defineTool({
      name: 'remove_todo',
      description:
        'Remove a todo by id, or every todo of an email by messageId (also deletes the Google Tasks).',
      sideEffect: 'write',
      input: z
        .object({ todoId: z.string().min(1).optional(), messageId: z.string().min(1).optional() })
        .refine((i) => !!i.todoId !== !!i.messageId, 'Give exactly one of todoId or messageId'),
      targets: (i) => [i.todoId ?? i.messageId!],
      handler: async (ctx, i) => {
        const ids = i.todoId
          ? [i.todoId]
          : (await repos.todos.list(ctx.accountId, { messageId: i.messageId })).map((t) => t.id);
        let removed = 0;
        for (const id of ids) if (await mailbox.removeTodo(ctx.accountId, id)) removed++;
        if (removed === 0)
          throw new NotFoundError(
            i.todoId ? `Todo ${i.todoId} not found` : `Email ${i.messageId} has no todos`,
          );
        return { removed };
      },
    }),

    // ---------- outbound ----------
    defineTool({
      name: 'send_email',
      description: 'Send a new email. Queued and delivered in the background.',
      sideEffect: 'outbound',
      input: z.object({
        to: addressList.min(1),
        cc: addressList.optional(),
        bcc: addressList.optional(),
        subject: z.string().max(998),
        body: z.string().describe('Plain-text body'),
        html: z.string().optional().describe('Optional HTML version of the body'),
        attachments: attachments.optional(),
      }),
      logParams: withoutContent,
      handler: async (ctx, i) => {
        const to = parseRecipients(i.to, 'to');
        if (to.length === 0)
          throw new ToolError('invalid_input', 'At least one recipient is required');
        const raw = await buildMime({
          from: await from(ctx),
          to,
          cc: parseRecipients(i.cc, 'cc'),
          bcc: parseRecipients(i.bcc, 'bcc'),
          subject: i.subject,
          text: i.body,
          html: i.html,
          attachments: decodeAttachments(i.attachments),
        });
        await mailbox.send(ctx.accountId, { raw });
        return { queued: true };
      },
    }),
    defineTool({
      name: 'reply_email',
      description:
        'Reply to an email in its thread, quoting it. replyAll also addresses the other recipients.',
      sideEffect: 'outbound',
      input: z.object({
        messageId: z.string().min(1),
        body: z.string(),
        html: z.string().optional(),
        replyAll: z.boolean().default(false),
        attachments: attachments.optional(),
      }),
      targets: (i) => [i.messageId],
      logParams: withoutContent,
      handler: async (ctx, i) => {
        const original = await message(ctx, i.messageId);
        const self = await from(ctx);
        const { to, cc } = replyRecipients(original, self.email, i.replyAll);
        if (to.length === 0)
          throw new ToolError('invalid_input', 'The email has no address to reply to');
        const body = quoteForReply(original, { text: i.body, html: i.html });
        const raw = await buildMime({
          from: self,
          to,
          cc,
          subject: replySubject(original.subject),
          text: body.text,
          html: body.html,
          inReplyTo: original.messageIdHeader,
          references: replyReferences(original),
          attachments: decodeAttachments(i.attachments),
        });
        await mailbox.send(ctx.accountId, { raw, threadId: original.threadId });
        return { queued: true, to: to.map((a) => a.email), cc: cc.map((a) => a.email) };
      },
    }),
    defineTool({
      name: 'forward_email',
      description:
        'Forward an email (with its attachments by default) to new recipients, with an optional note.',
      sideEffect: 'outbound',
      input: z.object({
        messageId: z.string().min(1),
        to: addressList.min(1),
        cc: addressList.optional(),
        bcc: addressList.optional(),
        body: z.string().optional().describe('Note above the forwarded email'),
        includeAttachments: z.boolean().default(true),
      }),
      targets: (i) => [i.messageId],
      logParams: withoutContent,
      handler: async (ctx, i) => {
        const original = await message(ctx, i.messageId);
        const to = parseRecipients(i.to, 'to');
        if (to.length === 0)
          throw new ToolError('invalid_input', 'At least one recipient is required');
        const files: OutgoingAttachment[] = [];
        if (i.includeAttachments) {
          for (const a of original.attachments) {
            const { content } = await loadAttachment(ctx, original, a.partId);
            files.push({
              filename: a.filename,
              contentType: a.mimeType,
              content,
              ...(a.contentId && { cid: a.contentId }),
            });
          }
          checkSize(files);
        }
        const body = forwardBody(original, { text: i.body });
        const raw = await buildMime({
          from: await from(ctx),
          to,
          cc: parseRecipients(i.cc, 'cc'),
          bcc: parseRecipients(i.bcc, 'bcc'),
          subject: forwardSubject(original.subject),
          text: body.text,
          html: body.html,
          attachments: files,
        });
        await mailbox.send(ctx.accountId, { raw });
        return { queued: true, attachments: files.length };
      },
    }),
  ];
}
