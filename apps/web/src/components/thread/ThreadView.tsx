import {
  Archive,
  ArrowLeft,
  Forward,
  Inbox,
  ListTodo,
  Mail,
  Reply,
  ReplyAll,
  Star,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EmailAddress, MailToolName, Message } from '../../api/mail';
import { useAuthStatus } from '../../state/auth';
import { useLabels, useMailTool, useThread } from '../../state/mail';
import { displayName } from '../../utils/format';
import { type ComposeMode, useComposeActions, useToast } from '../../state/ui';
import { LabelMenu } from '../mail/LabelMenu';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { LabelChip } from '../ui/LabelChip';
import { Spinner } from '../ui/Spinner';
import { MessageCard } from './MessageCard';
import { openThread } from '../../router/mail-params';

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

export function ThreadView({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const labels = useLabels();
  const auth = useAuthStatus();
  const tool = useMailTool();
  const openCompose = useComposeActions().open;
  const toast = useToast();
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
  const act = (name: MailToolName, closeAfter = false) => {
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
