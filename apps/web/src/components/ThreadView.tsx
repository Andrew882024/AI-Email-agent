import {
  Archive,
  ArrowLeft,
  Download,
  Forward,
  Inbox,
  ListTodo,
  Mail,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuthStatus, useLabels, useThread, useTool } from '../api/queries';
import type { EmailAddress, Message } from '../api/types';
import { displayName, fileSize, longDate } from '../lib/format';
import { type ComposeMode, useUi } from '../store';
import { EmailBody } from './EmailBody';
import { LabelMenu } from './LabelMenu';
import { Button, EmptyState, IconButton, LabelChip, Spinner } from './ui';

const prefix = (subject: string, p: 'Re' | 'Fwd') =>
  new RegExp(`^${p === 'Re' ? 're' : 'fwd?|fw'}:`, 'i').test(subject.trim())
    ? subject
    : `${p}: ${subject}`;

/** Who a reply goes to, for display (the server computes the real recipients the same way). */
function replyTargets(message: Message, self: string, all: boolean): EmailAddress[] {
  const mine = message.from?.email.toLowerCase() === self.toLowerCase();
  const primary = mine
    ? message.to
    : message.replyTo.length
      ? message.replyTo
      : message.from
        ? [message.from]
        : [];
  if (!all) return primary;
  const seen = new Set<string>([self.toLowerCase()]);
  const everyone = [...primary, ...message.to, ...message.cc].filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Mail only to myself: reply-all goes back to me, as the server does.
  return everyone.length > 0 ? everyone : primary;
}

function MessageCard(props: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
  self: string;
  onCompose: (mode: ComposeMode) => void;
}) {
  const { message, self } = props;
  const [details, setDetails] = useState(false);
  const recipients = [...message.to, ...message.cc];
  const sender = message.from;
  // Inline images shown inside the body aren't listed again as files.
  const files = message.attachments.filter(
    (a) => !(a.contentId && message.bodyHtml?.includes(`cid:${a.contentId}`)),
  );

  if (!props.expanded) {
    return (
      <button
        type="button"
        onClick={props.onToggle}
        className="flex w-full items-center gap-4 border-b border-gray-100 px-6 py-3 text-left text-sm hover:bg-gray-50"
      >
        <span className="w-48 shrink-0 truncate font-medium">{displayName(sender, self)}</span>
        <span className="flex-1 truncate text-gray-600">{message.snippet}</span>
        <span className="shrink-0 text-xs text-gray-500">{longDate(message.internalDate)}</span>
      </button>
    );
  }

  return (
    <article className="border-b border-gray-100 px-6 py-4">
      <header className="mb-3 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-500 font-medium text-white">
          {displayName(sender).charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={props.onToggle}>
          <div className="text-sm">
            <span className="font-semibold">{sender?.name ?? sender?.email}</span>
            {sender?.name && <span className="text-xs text-gray-600"> &lt;{sender.email}&gt;</span>}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDetails(!details);
            }}
            className="text-xs text-gray-600 hover:underline"
          >
            to {recipients.map((a) => displayName(a, self)).join(', ') || '(no recipients)'} ▾
          </button>
          {details && (
            <dl className="mt-2 grid grid-cols-[4rem_1fr] gap-x-2 gap-y-0.5 text-xs text-gray-700">
              <dt className="text-gray-500">from:</dt>
              <dd>{sender?.email}</dd>
              <dt className="text-gray-500">to:</dt>
              <dd>{message.to.map((a) => a.email).join(', ')}</dd>
              {message.cc.length > 0 && (
                <>
                  <dt className="text-gray-500">cc:</dt>
                  <dd>{message.cc.map((a) => a.email).join(', ')}</dd>
                </>
              )}
              <dt className="text-gray-500">date:</dt>
              <dd>{longDate(message.internalDate)}</dd>
            </dl>
          )}
        </div>
        <span className="shrink-0 text-xs text-gray-600">{longDate(message.internalDate)}</span>
        <IconButton label="Reply" onClick={() => props.onCompose('reply')}>
          <Reply className="h-[18px] w-[18px]" />
        </IconButton>
      </header>
      <div className="pl-13">
        <EmailBody message={message} />
        {files.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {files.map((a) => (
              <a
                key={a.partId}
                href={`/api/messages/${message.id}/attachments/${encodeURIComponent(a.partId)}`}
                target="_blank"
                rel="noreferrer"
                className="flex w-56 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
              >
                <Paperclip className="h-4 w-4 shrink-0 text-gray-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{a.filename || 'attachment'}</span>
                  <span className="text-xs text-gray-500">{fileSize(a.size)}</span>
                </span>
                <Download className="h-4 w-4 shrink-0 text-gray-500" />
              </a>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const labels = useLabels();
  const auth = useAuthStatus();
  const tool = useTool();
  const openThread = useUi((s) => s.openThread);
  const openCompose = useUi((s) => s.openCompose);
  const toast = useUi((s) => s.toast);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const markedRead = useRef(false);
  const self = auth.data?.account?.email ?? '';
  const messages = thread.data?.messages ?? [];

  // Opening a conversation reads it, like Gmail.
  const markRead = tool.mutate;
  useEffect(() => {
    const loaded = thread.data?.messages;
    if (markedRead.current || !loaded?.length) return;
    markedRead.current = true;
    const unread = loaded.filter((m) => !m.isRead).map((m) => m.id);
    if (unread.length > 0)
      markRead({ name: 'mark_read', input: { messageIds: unread }, silent: true });
  }, [thread.data, markRead]);

  if (thread.isLoading) {
    return (
      <EmptyState>
        <Spinner />
      </EmptyState>
    );
  }
  if (thread.error || messages.length === 0) {
    return (
      <EmptyState>
        {thread.error
          ? `Couldn't open this conversation: ${thread.error.message}`
          : 'Conversation not found.'}
      </EmptyState>
    );
  }

  const ids = messages.map((m) => m.id);
  const labelIds = [...new Set(messages.flatMap((m) => m.labelIds))];
  const inInbox = labelIds.includes('INBOX');
  const starred = messages.some((m) => m.isStarred);
  const latest = messages.at(-1)!;
  const subject = messages[0]!.subject || '(no subject)';
  const userLabels = (labels.data ?? []).filter(
    (l) => l.type === 'user' && labelIds.includes(l.id),
  );
  const isExpanded = (m: Message) => m.id === latest.id || !m.isRead || expanded.has(m.id);

  const compose = (message: Message, mode: ComposeMode) =>
    openCompose({
      mode,
      sourceMessageId: message.id,
      subject: prefix(message.subject, mode === 'forward' ? 'Fwd' : 'Re'),
      replyPreview:
        mode === 'forward'
          ? undefined
          : replyTargets(message, self, mode === 'replyAll')
              .map((a) => displayName(a, self))
              .join(', '),
    });
  const act = (name: string, closeAfter = false) => {
    tool.mutate({ name, input: { messageIds: ids } });
    if (closeAfter) openThread(undefined);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-gray-100 px-3">
        <IconButton label="Back" onClick={() => openThread(undefined)}>
          <ArrowLeft className="h-[18px] w-[18px]" />
        </IconButton>
        <IconButton
          label={inInbox ? 'Archive' : 'Move to inbox'}
          onClick={() => act(inInbox ? 'archive' : 'move_to_inbox', inInbox)}
        >
          {inInbox ? (
            <Archive className="h-[18px] w-[18px]" />
          ) : (
            <Inbox className="h-[18px] w-[18px]" />
          )}
        </IconButton>
        <IconButton label="Mark as unread" onClick={() => act('mark_unread', true)}>
          <Mail className="h-[18px] w-[18px]" />
        </IconButton>
        <IconButton
          label={starred ? 'Unstar' : 'Star'}
          onClick={() => act(starred ? 'unstar' : 'star')}
        >
          <Star
            className={`h-[18px] w-[18px] ${starred ? 'fill-yellow-400 text-yellow-500' : ''}`}
          />
        </IconButton>
        <LabelMenu messageIds={ids} labelIds={[labelIds]} />
        <IconButton
          label="Add to Todos"
          onClick={() =>
            tool.mutate(
              { name: 'add_todo', input: { messageId: latest.id } },
              { onSuccess: () => toast('Added to Todos') },
            )
          }
        >
          <ListTodo className="h-[18px] w-[18px]" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-5">
          <h1 className="text-[22px] text-gray-900">{subject}</h1>
          {userLabels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            message={m}
            self={self}
            expanded={isExpanded(m)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(m.id)) next.delete(m.id);
                else next.add(m.id);
                return next;
              })
            }
            onCompose={(mode) => compose(m, mode)}
          />
        ))}
        <div className="flex gap-3 px-6 py-6">
          <Button onClick={() => compose(latest, 'reply')}>
            <Reply className="h-4 w-4" /> Reply
          </Button>
          <Button onClick={() => compose(latest, 'replyAll')}>
            <ReplyAll className="h-4 w-4" /> Reply all
          </Button>
          <Button onClick={() => compose(latest, 'forward')}>
            <Forward className="h-4 w-4" /> Forward
          </Button>
        </div>
      </div>
    </div>
  );
}
