import { useEffect, useMemo } from 'react';
import { ChatPanel } from '../../components/assistant/ChatPanel';
import { ComposeDock } from '../../components/compose/ComposeDock';
import { Sidebar } from '../../components/layout/Sidebar';
import { Toasts } from '../../components/layout/Toasts';
import { TopBar } from '../../components/layout/TopBar';
import { MailboxView } from '../../components/mailbox/MailboxView';
import { ThreadView } from '../../components/thread/ThreadView';
import { TodosView } from '../../components/todos/TodosView';
import { WorkflowDetails } from '../../components/workflows/WorkflowDetails';
import { WorkflowsView } from '../../components/workflows/WorkflowsView';
import { Spinner } from '../../components/ui/Spinner';
import { type MailParams, showList } from '../../router/mail-params';
import { type MailboxQuery, useLabels } from '../../state/mail';
import { useServerEvents } from '../../state/sync';
import { useChatPanel, useSelection } from '../../state/ui';

/**
 * The mail page (/mail). Its parameters come from the URL (parsed in router/routes.tsx): `list` and
 * `page` decide which mail is fetched and shown; `threadId` switches the middle area from the list
 * to that conversation. Top bar, sidebar, assistant and overlays always stay.
 */
export function MailPage({ params }: { params: MailParams }) {
  const { list, page, threadId } = params;
  const labels = useLabels();
  const chatOpen = useChatPanel().open;
  const setSelected = useSelection().set;
  useServerEvents();

  // The URL names labels; the server and the cached lists use label ids.
  const labelName = list.kind === 'label' ? list.name.toLowerCase() : undefined;
  const label = labelName
    ? (labels.data?.find((l) => l.name.toLowerCase() === labelName) ??
      labels.data?.find((l) => l.id.toLowerCase() === labelName))
    : undefined;
  const missingLabel = !!labelName && !!labels.data && !label;
  const view = list.kind === 'view' ? list.view : 'all';
  const search = list.kind === 'search' ? list.query : undefined;
  const labelId = label?.id;
  const labelDisplayName = label?.name;
  // Stable while the list is the same, so page-cursor lookups aren't restarted by re-renders.
  const mailbox = useMemo<MailboxQuery | undefined>(() => {
    if (list.kind === 'todos' || list.kind === 'workflows' || (labelName && !labelId))
      return undefined;
    return { view, label: labelId, labelName: labelDisplayName, query: search };
  }, [list.kind, view, labelName, labelId, labelDisplayName, search]);

  useEffect(() => {
    if (missingLabel) showList({ kind: 'view', view: 'inbox' }, { replace: true });
  }, [missingLabel]);
  // A new list, page or conversation starts with nothing selected.
  useEffect(() => setSelected([]), [mailbox, page, threadId, setSelected]);

  return (
    <div className="flex h-screen flex-col bg-[#f6f8fc] text-[#1f1f1f]">
      <TopBar search={search ?? ''} />
      <div className="flex min-h-0 flex-1">
        <Sidebar list={list} />
        <main className="mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white">
          {threadId ? (
            <ThreadView key={threadId} threadId={threadId} />
          ) : list.kind === 'todos' ? (
            <TodosView />
          ) : list.kind === 'workflows' ? (
            list.id ? (
              <WorkflowDetails key={list.id} id={list.id} />
            ) : (
              <WorkflowsView />
            )
          ) : mailbox ? (
            <MailboxView list={mailbox} page={page} />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          )}
        </main>
        {chatOpen && <ChatPanel />}
      </div>
      <ComposeDock />
      <Toasts />
    </div>
  );
}
