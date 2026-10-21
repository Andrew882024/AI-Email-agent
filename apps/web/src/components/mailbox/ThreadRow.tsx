import { Archive, Inbox, ListTodo, Mail, MailOpen, Paperclip, Star } from 'lucide-react';
import { useTool } from '../../api/queries';
import type { Label, ThreadSummary } from '../../api/types';
import { Checkbox } from '../ui/Checkbox';
import { IconButton } from '../ui/IconButton';
import { LabelChip } from '../ui/LabelChip';
import { participantsLine, shortDate } from '../../lib/format';
import { useUi } from '../../store';
import { useAddTodos } from './useAddTodos';
import { openThread } from '../../router/mail-params';

/** One conversation in the list, with its hover actions. */
export function ThreadRow(props: {
  thread: ThreadSummary;
  labels: Map<string, Label>;
  self?: string;
  selected: boolean;
  archiveView: boolean;
}) {
  const { thread, labels, self } = props;
  const toggleSelected = useUi((s) => s.toggleSelected);
  const tool = useTool();
  const addTodos = useAddTodos();
  const ids = thread.messageIds;
  const unread = !thread.isRead;
  const chips = thread.labelIds.flatMap((id) => {
    const label = labels.get(id);
    return label?.type === 'user' ? [label] : [];
  });

  return (
    <div
      role="row"
      onClick={() => openThread(thread.threadId)}
      className={`group relative flex h-10 cursor-pointer items-center gap-2 border-b border-gray-100 px-3 text-sm hover:z-10 hover:shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_rgba(60,64,67,.3)] ${props.selected ? 'bg-[#c2dbff]' : unread ? 'bg-white' : 'bg-[#f2f6fc]'}`}
    >
      <Checkbox
        checked={props.selected}
        onChange={() => toggleSelected(thread.threadId)}
        label="Select conversation"
      />
      <IconButton
        label={thread.isStarred ? 'Unstar' : 'Star'}
        onClick={() =>
          tool.mutate({ name: thread.isStarred ? 'unstar' : 'star', input: { messageIds: ids } })
        }
        className="h-8 w-8"
      >
        <Star className={`h-4 w-4 ${thread.isStarred ? 'fill-yellow-400 text-yellow-500' : ''}`} />
      </IconButton>
      <div className={`w-52 shrink-0 truncate ${unread ? 'font-semibold' : ''}`}>
        {participantsLine(thread.participants, self)}
        {thread.messageCount > 1 && (
          <span className="ml-1 text-xs font-normal text-gray-500">{thread.messageCount}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {chips.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
        <span className={`truncate ${unread ? 'font-semibold' : ''}`}>
          {thread.subject || '(no subject)'}
          <span className="font-normal text-gray-500"> — {thread.snippet}</span>
        </span>
      </div>
      {thread.hasAttachments && <Paperclip className="h-4 w-4 shrink-0 text-gray-500" />}
      <span
        className={`w-16 shrink-0 text-right text-xs group-hover:invisible ${unread ? 'font-semibold' : 'text-gray-600'}`}
      >
        {shortDate(thread.lastMessageAt)}
      </span>
      <div className="absolute right-2 hidden items-center group-hover:flex">
        <IconButton
          label={props.archiveView ? 'Move to inbox' : 'Archive'}
          onClick={() =>
            tool.mutate({
              name: props.archiveView ? 'move_to_inbox' : 'archive',
              input: { messageIds: ids },
            })
          }
        >
          {props.archiveView ? (
            <Inbox className="h-[18px] w-[18px]" />
          ) : (
            <Archive className="h-[18px] w-[18px]" />
          )}
        </IconButton>
        <IconButton
          label={unread ? 'Mark as read' : 'Mark as unread'}
          onClick={() =>
            tool.mutate({ name: unread ? 'mark_read' : 'mark_unread', input: { messageIds: ids } })
          }
        >
          {unread ? (
            <MailOpen className="h-[18px] w-[18px]" />
          ) : (
            <Mail className="h-[18px] w-[18px]" />
          )}
        </IconButton>
        <IconButton label="Add to Todos" onClick={() => void addTodos([thread])}>
          <ListTodo className="h-[18px] w-[18px]" />
        </IconButton>
      </div>
    </div>
  );
}
