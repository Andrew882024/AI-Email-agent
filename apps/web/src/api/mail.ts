import { z } from 'zod';
import { callTool, IsoDate, optional, query, request } from './client';

// ---- shapes ----

export const VIEWS = [
  'inbox',
  'starred',
  'unread',
  'sent',
  'drafts',
  'archived',
  'all',
  'trash',
  'spam',
] as const;
export type View = (typeof VIEWS)[number];

export const EmailAddress = z.object({ name: optional(z.string()), email: z.string() });
export type EmailAddress = z.output<typeof EmailAddress>;

export const ThreadSummary = z.object({
  threadId: z.string(),
  subject: z.string(),
  snippet: z.string(),
  lastMessageAt: IsoDate,
  messageCount: z.number(),
  participants: z.array(EmailAddress),
  labelIds: z.array(z.string()),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  inInbox: z.boolean(),
  hasAttachments: z.boolean(),
  messageIds: z.array(z.string()),
});
export type ThreadSummary = z.output<typeof ThreadSummary>;

export const ThreadPage = z.object({
  items: z.array(ThreadSummary),
  nextCursor: optional(z.string()),
});
export type ThreadPage = z.output<typeof ThreadPage>;

export const Attachment = z.object({
  partId: z.string(),
  attachmentId: optional(z.string()),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  contentId: optional(z.string()),
});
export type Attachment = z.output<typeof Attachment>;

export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  from: optional(EmailAddress),
  to: z.array(EmailAddress),
  cc: z.array(EmailAddress),
  bcc: z.array(EmailAddress),
  replyTo: z.array(EmailAddress),
  subject: z.string(),
  snippet: z.string(),
  internalDate: IsoDate,
  hasAttachments: z.boolean(),
  labelIds: z.array(z.string()),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  inInbox: z.boolean(),
  bodyText: optional(z.string()),
  bodyHtml: optional(z.string()),
  attachments: z.array(Attachment),
});
export type Message = z.output<typeof Message>;

export const Thread = z.object({ threadId: z.string(), messages: z.array(Message) });
export type Thread = z.output<typeof Thread>;

export const Label = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['system', 'user']),
  color: optional(z.object({ background: z.string(), text: z.string() })),
  total: z.number(),
  unread: z.number(),
});
export type Label = z.output<typeof Label>;

export const Todo = z.object({
  id: z.string(),
  messageId: optional(z.string()),
  googleTaskId: optional(z.string()),
  title: z.string(),
  status: z.enum(['needsAction', 'completed']),
  due: optional(IsoDate),
  completedAt: optional(IsoDate),
  createdAt: IsoDate,
  message: optional(
    z.object({
      id: z.string(),
      threadId: z.string(),
      subject: z.string(),
      from: optional(EmailAddress),
    }),
  ),
});
export type Todo = z.output<typeof Todo>;

// ---- requests ----

export interface ThreadListQuery {
  view: View;
  /** Label id. */
  label?: string;
  query?: string;
  limit: number;
  cursor?: string;
}

export const listThreads = (q: ThreadListQuery) =>
  request(
    ThreadPage,
    `/api/threads${query({ view: q.view, label: q.label, q: q.query, limit: q.limit, cursor: q.cursor })}`,
  );

export const getThread = (threadId: string) =>
  request(Thread, `/api/threads/${encodeURIComponent(threadId)}`);

export const listLabels = () => request(z.array(Label), '/api/labels');

export const listTodos = () => request(z.array(Todo), '/api/todos');

/** Mailbox tools whose result the app doesn't use (it re-reads the data instead). */
export type MailToolName =
  | 'mark_read'
  | 'mark_unread'
  | 'star'
  | 'unstar'
  | 'archive'
  | 'move_to_inbox'
  | 'add_label'
  | 'remove_label'
  | 'add_todo'
  | 'remove_todo'
  | 'send_email'
  | 'reply_email'
  | 'forward_email';

export const runMailTool = (name: MailToolName, input: Record<string, unknown>) =>
  callTool(name, input, z.unknown());

export const createLabel = (name: string) =>
  callTool(
    'create_label',
    { name },
    z.object({ label: z.object({ id: z.string(), name: z.string() }) }),
  ).then((r) => r.label);

/** Where the browser loads an attachment (links and inline images). */
export const attachmentUrl = (messageId: string, partId: string) =>
  `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`;
