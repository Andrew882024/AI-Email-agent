import { useServerEvents } from '../../api/events';
import { useAuthStatus } from '../../api/queries';
import { useHashRouter } from '../../router';
import { useUi } from '../../store';
import { ChatPanel } from '../assistant/ChatPanel';
import { ComposeDock } from '../compose/ComposeDock';
import { ConnectGoogleModal } from './ConnectGoogleModal';
import { MailboxPage } from '../../pages/mailbox/MailboxPage';
import { Sidebar } from './Sidebar';
import { ThreadPage } from '../../pages/thread/ThreadPage';
import { Toasts } from './Toasts';
import { TodosPage } from '../../pages/todos/TodosPage';
import { TopBar } from './TopBar';

/** The frame every page shares: top bar, sidebar, the current page, assistant and overlays. */
export function Layout() {
  const auth = useAuthStatus();
  const connected = !!auth.data?.account;
  const route = useUi((s) => s.route);
  const openThreadId = useUi((s) => s.openThreadId);
  const chatOpen = useUi((s) => s.chatOpen);
  useServerEvents(connected);
  useHashRouter();

  return (
    <div className="flex h-screen flex-col bg-[#f6f8fc] text-[#1f1f1f]">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white">
          {!connected ? null : openThreadId ? (
            <ThreadPage key={openThreadId} threadId={openThreadId} />
          ) : route.kind === 'todos' ? (
            <TodosPage />
          ) : (
            <MailboxPage route={route} />
          )}
        </main>
        {chatOpen && <ChatPanel />}
      </div>
      <ComposeDock />
      <Toasts />
      <ConnectGoogleModal />
    </div>
  );
}
