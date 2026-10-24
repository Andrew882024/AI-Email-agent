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
import type { MailToolName, View } from '../../api/mail';
import { useAuthStatus } from '../../state/auth';
import {
  type MailboxQuery,
  PAGE_SIZE,
  useAddTodos,
  useLabels,
  useMailTool,
  usePageCursor,
  useRefreshThreads,
  useThreads,
} from '../../state/mail';
import { useSelection } from '../../state/ui';
import { LabelMenu } from '../mail/LabelMenu';
import { Checkbox } from '../ui/Checkbox';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { Spinner } from '../ui/Spinner';
import { showPage } from '../../router/mail-params';
import { ThreadRow } from './ThreadRow';

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

/** A page of a thread list, with bulk actions and paging. */
export function MailboxView({ list, page }: { list: MailboxQuery; page: number }) {
  const { selected, set: setSelected } = useSelection();
  const { cursor, ready, rememberNext } = usePageCursor(list, page);
  const threads = useThreads(list, cursor, ready);
  const labels = useLabels();
  const auth = useAuthStatus();
  const tool = useMailTool();
  const addTodos = useAddTodos();
  const refreshThreads = useRefreshThreads();

  const labelMap = new Map((labels.data ?? []).map((l) => [l.id, l]));
  const items = threads.data?.items ?? [];
  const chosen = items.filter((t) => selected.includes(t.threadId));
  const chosenIds = chosen.flatMap((t) => t.messageIds);
  const archiveView = list.view === 'archived';
  const anyUnread = chosen.some((t) => !t.isRead);
  const anyUnstarred = chosen.some((t) => !t.isStarred);
  const run = (name: MailToolName) => {
    tool.mutate({ name, input: { messageIds: chosenIds } });
    setSelected([]);
  };
  const title = list.query
    ? `Search results for “${list.query}”`
    : list.label
      ? (list.labelName ?? labelMap.get(list.label)?.name ?? 'Label')
      : VIEW_TITLES[list.view];
  const olderPage = () => {
    const next = threads.data?.nextCursor;
    if (!next) return;
    // Remember how to load the next page, so it (and a reload of it) needs no extra requests.
    rememberNext(next);
    showPage(page + 1);
  };
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
          <IconButton label="Refresh" onClick={refreshThreads}>
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
          <IconButton label="Newer" onClick={() => showPage(page - 1)} disabled={page <= 1}>
            <ChevronLeft className="h-[18px] w-[18px]" />
          </IconButton>
          <IconButton label="Older" onClick={olderPage} disabled={!threads.data?.nextCursor}>
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
            {list.query ? 'No messages matched your search.' : 'Nothing here.'}
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
