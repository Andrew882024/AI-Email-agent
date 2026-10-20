import { useServerEvents } from '../api/events';
import { useAuthStatus } from '../api/queries';
import { useUi } from '../store';
import { ChatPanel } from './ChatPanel';
import { ComposeDock } from './ComposeDock';
import { ConnectGoogleModal } from './ConnectGoogleModal';
import { MailList } from './MailList';
import { Sidebar } from './Sidebar';
import { ThreadView } from './ThreadView';
import { Toasts } from './Toasts';
import { TodosView } from './TodosView';
import { TopBar } from './TopBar';

export function App() {
  const auth = useAuthStatus();
  const connected = !!auth.data?.account;
  const route = useUi((s) => s.route);
  const openThreadId = useUi((s) => s.openThreadId);
  const chatOpen = useUi((s) => s.chatOpen);
  useServerEvents(connected);

  return (
    <div className="flex h-screen flex-col bg-[#f6f8fc] text-[#1f1f1f]">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white">
          {!connected ? null : openThreadId ? (
            <ThreadView key={openThreadId} threadId={openThreadId} />
          ) : route.kind === 'todos' ? (
            <TodosView />
          ) : (
            <MailList route={route} />
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
