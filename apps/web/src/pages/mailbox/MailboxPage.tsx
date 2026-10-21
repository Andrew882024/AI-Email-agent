import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Inbox,
  ListTodo,
  Mail,
  MailOpen,
  RefreshCw,
  Star,
} from 'lucide-react';
import { PAGE_SIZE, useAuthStatus, useLabels, useThreads, useTool } from '../../api/queries';
import type { View } from '../../api/types';
import { LabelMenu } from '../../components/mail/LabelMenu';
import { Checkbox } from '../../components/ui/Checkbox';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/IconButton';
import { Spinner } from '../../components/ui/Spinner';
import { usePageCursor } from '../../router';
import { type Route, useUi } from '../../store';
import { ThreadRow } from './ThreadRow';
import { useAddTodos } from './useAddTodos';

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

export function MailboxPage({ route }: { route: Extract<Route, { kind: 'mail' }> }) {
  const page = useUi((s) => s.page);
  const selected = useUi((s) => s.selected);
  const setSelected = useUi((s) => s.setSelected);
  const nextPage = useUi((s) => s.nextPage);
  const prevPage = useUi((s) => s.prevPage);
  const { cursor, ready } = usePageCursor(route, page);
  const threads = useThreads(route, cursor, ready);
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
  const first = (page - 1) * PAGE_SIZE + 1;

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
          <IconButton label="Newer" onClick={prevPage} disabled={page <= 1}>
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
        {!ready || threads.isLoading ? (
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
