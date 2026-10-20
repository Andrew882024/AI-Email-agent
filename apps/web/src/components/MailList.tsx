import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Inbox,
  ListTodo,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Star,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { PAGE_SIZE, useAuthStatus, useLabels, useThreads, useTool } from '../api/queries';
import type { Label, ThreadSummary, View } from '../api/types';
import { participantsLine, shortDate } from '../lib/format';
import { type Route, useUi } from '../store';
import { LabelMenu } from './LabelMenu';
import { Checkbox, EmptyState, IconButton, LabelChip, Spinner } from './ui';

const VIEW_TITLES: Record<View, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  unread: 'Unread',
  sent: 'Sent',
  drafts: 'Drafts',
  archived: 'Archived',
  all: 'All Mail',
  trash: 'Trash',
  spam: 'Spam',
};

/** Add a todo for each thread, attached to its newest message. */
function useAddTodos() {
  const tool = useTool();
  const toast = useUi((s) => s.toast);
  return async (threads: ThreadSummary[]) => {
    await Promise.all(
      threads.map((t) =>
        tool.mutateAsync({ name: 'add_todo', input: { messageId: t.messageIds.at(-1)! } }),
      ),
    ).then(
      () => toast(threads.length === 1 ? 'Added to Todos' : `Added ${threads.length} todos`),
      () => {}, // useTool already reported the error
    );
  };
}

function ThreadRow(props: {
  thread: ThreadSummary;
  labels: Map<string, Label>;
  self?: string;
  selected: boolean;
  archiveView: boolean;
}) {
  const { thread, labels, self } = props;
  const openThread = useUi((s) => s.openThread);
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

export function MailList({ route }: { route: Extract<Route, { kind: 'mail' }> }) {
  const cursors = useUi((s) => s.cursors);
  const selected = useUi((s) => s.selected);
  const setSelected = useUi((s) => s.setSelected);
  const nextPage = useUi((s) => s.nextPage);
  const prevPage = useUi((s) => s.prevPage);
  const threads = useThreads(route, cursors.at(-1));
  const labels = useLabels();
  const auth = useAuthStatus();
  const tool = useTool();
  const addTodos = useAddTodos();
  const qc = useQueryClient();

  const labelMap = new Map((labels.data ?? []).map((l) => [l.id, l]));
  const items = threads.data?.items ?? [];
  const chosen = items.filter((t) => selected.includes(t.threadId));
  const chosenIds = chosen.flatMap((t) => t.messageIds);
  const archiveView = route.view === 'archived';
  const anyUnread = chosen.some((t) => !t.isRead);
  const anyUnstarred = chosen.some((t) => !t.isStarred);
  const run = (name: string) => {
    tool.mutate({ name, input: { messageIds: chosenIds } });
    setSelected([]);
  };
  const title = route.query
    ? `Search results for “${route.query}”`
    : route.label
      ? (labelMap.get(route.label)?.name ?? 'Label')
      : VIEW_TITLES[route.view];
  const first = (cursors.length - 1) * PAGE_SIZE + 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-gray-100 px-3">
        <span className="px-2">
          <Checkbox
            label="Select all"
            checked={items.length > 0 && chosen.length === items.length}
            indeterminate={chosen.length > 0 && chosen.length < items.length}
            onChange={() =>
              setSelected(chosen.length === items.length ? [] : items.map((t) => t.threadId))
            }
          />
        </span>
        {chosen.length === 0 ? (
          <IconButton
            label="Refresh"
            onClick={() => void qc.invalidateQueries({ queryKey: ['threads'] })}
          >
            <RefreshCw
              className={`h-[18px] w-[18px] ${threads.isFetching ? 'animate-spin' : ''}`}
            />
          </IconButton>
        ) : (
          <>
            <IconButton
              label={archiveView ? 'Move to inbox' : 'Archive'}
              onClick={() => run(archiveView ? 'move_to_inbox' : 'archive')}
            >
              {archiveView ? (
                <Inbox className="h-[18px] w-[18px]" />
              ) : (
                <Archive className="h-[18px] w-[18px]" />
              )}
            </IconButton>
            <IconButton
              label={anyUnread ? 'Mark as read' : 'Mark as unread'}
              onClick={() => run(anyUnread ? 'mark_read' : 'mark_unread')}
            >
              {anyUnread ? (
                <MailOpen className="h-[18px] w-[18px]" />
              ) : (
                <Mail className="h-[18px] w-[18px]" />
              )}
            </IconButton>
            <IconButton
              label={anyUnstarred ? 'Star' : 'Unstar'}
              onClick={() => run(anyUnstarred ? 'star' : 'unstar')}
            >
              <Star className="h-[18px] w-[18px]" />
            </IconButton>
            <LabelMenu messageIds={chosenIds} labelIds={chosen.map((t) => t.labelIds)} />
            <IconButton
              label="Add to Todos"
              onClick={() => void addTodos(chosen).then(() => setSelected([]))}
            >
              <ListTodo className="h-[18px] w-[18px]" />
            </IconButton>
            <span className="ml-2 text-sm text-gray-600">{chosen.length} selected</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1 text-xs text-gray-600">
          {items.length > 0 && (
            <span>
              {first.toLocaleString()}–{(first + items.length - 1).toLocaleString()}
            </span>
          )}
          <IconButton label="Newer" onClick={prevPage} disabled={cursors.length <= 1}>
            <ChevronLeft className="h-[18px] w-[18px]" />
          </IconButton>
          <IconButton
            label="Older"
            onClick={() => threads.data?.nextCursor && nextPage(threads.data.nextCursor)}
            disabled={!threads.data?.nextCursor}
          >
            <ChevronRight className="h-[18px] w-[18px]" />
          </IconButton>
        </div>
      </div>
      <h1 className="px-5 pb-1 pt-3 text-sm font-medium text-gray-700">{title}</h1>
      <div className="min-h-0 flex-1 overflow-y-auto" role="grid" aria-label={title}>
        {threads.isLoading ? (
          <EmptyState>
            <Spinner />
          </EmptyState>
        ) : threads.error ? (
          <EmptyState>Couldn't load mail: {threads.error.message}</EmptyState>
        ) : items.length === 0 ? (
          <EmptyState>
            {route.query ? 'No messages matched your search.' : 'Nothing here.'}
          </EmptyState>
        ) : (
          items.map((thread) => (
            <ThreadRow
              key={thread.threadId}
              thread={thread}
              labels={labelMap}
              self={auth.data?.account?.email}
              selected={selected.includes(thread.threadId)}
              archiveView={archiveView}
            />
          ))
        )}
      </div>
    </div>
  );
}
