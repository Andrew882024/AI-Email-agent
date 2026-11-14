import { Bot } from 'lucide-react';
import { type ReactNode } from 'react';
import { APP_URL } from '../config';
import { useSession } from '../state/auth';
import { ChatPanel } from './ChatPanel';
import { Toasts } from './Toasts';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Bot className="h-8 w-8 text-blue-600" />
      <h1 className="text-base font-medium">{title}</h1>
      {children}
    </div>
  );
}

/** The side panel: the assistant once this browser is signed in to the app. */
export function App() {
  const session = useSession();
  switch (session.state) {
    case 'loading':
      return (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      );
    case 'unreachable':
      return (
        <Notice title="Can't reach AI Email Agent">
          <p className="text-sm text-gray-600">
            {session.code === 'forbidden' ? (
              <>
                The server doesn't allow this extension yet. Add{' '}
                <code className="rounded bg-gray-100 px-1 text-xs break-all">
                  chrome-extension://{chrome.runtime.id}
                </code>{' '}
                to ALLOWED_ORIGINS in apps/server/.env and restart the server.
              </>
            ) : (
              session.message
            )}
          </p>
          <Button onClick={session.recheck}>Try again</Button>
        </Notice>
      );
    case 'signed_out':
      return (
        <Notice title="Sign in to AI Email Agent">
          <p className="text-sm text-gray-600">
            The assistant works on the mail the app syncs. Sign in there, then come back here.
          </p>
          <Button
            variant="primary"
            onClick={() => void chrome.tabs.create({ url: `${APP_URL}/login` })}
          >
            Open the app to sign in
          </Button>
          <button
            type="button"
            onClick={session.recheck}
            className="text-xs text-blue-700 hover:underline"
          >
            I've signed in
          </button>
        </Notice>
      );
    case 'signed_in':
      return (
        <>
          <ChatPanel email={session.email} />
          <Toasts />
        </>
      );
  }
}
