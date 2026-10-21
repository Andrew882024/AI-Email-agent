import * as Menu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  LogOut,
  Mail,
  MessageSquare,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { useAuthStatus, useSyncStatus } from '../../api/queries';
import { showList } from '../../router/mail-params';
import { useUi } from '../../store';
import { IconButton } from '../ui/IconButton';
import { Spinner } from '../ui/Spinner';

function SyncIndicator() {
  const sync = useUi((s) => s.sync);
  const status = useSyncStatus(true);
  const pending = status.data?.outboxPending ?? 0;
  if (sync.phase === 'full_sync' || status.data?.fullSync) {
    const synced = sync.synced ?? status.data?.fullSync?.synced ?? 0;
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-600">
        <Spinner className="h-3.5 w-3.5 text-blue-600" /> Syncing mailbox… {synced.toLocaleString()}
      </span>
    );
  }
  if (sync.phase === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-red-700" title={sync.error}>
        <AlertTriangle className="h-3.5 w-3.5" /> Sync error
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-500" title="Synced with Gmail">
      <Check className="h-3.5 w-3.5 text-green-600" />
      {pending > 0 ? `${pending} change${pending > 1 ? 's' : ''} to sync` : 'Up to date'}
    </span>
  );
}

/** Search (`search` is the query in the URL), sync status, assistant toggle and account menu. */
export function TopBar({ search }: { search: string }) {
  const toggleChat = useUi((s) => s.toggleChat);
  const chatOpen = useUi((s) => s.chatOpen);
  const auth = useAuthStatus();
  const qc = useQueryClient();
  const activeQuery = search;
  const [text, setText] = useState(activeQuery);
  const [shownQuery, setShownQuery] = useState(activeQuery);
  // Keep the box in step when navigation clears the search.
  if (shownQuery !== activeQuery) {
    setShownQuery(activeQuery);
    setText(activeQuery);
  }
  const refresh = useMutation({ mutationFn: () => api('/api/sync/now', { method: 'POST' }) });
  const logout = useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    showList(q ? { kind: 'search', query: q } : { kind: 'view', view: 'inbox' });
  };
  const account = auth.data?.account;

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 px-4">
      <div className="flex w-56 items-center gap-2 pl-2">
        <Mail className="h-6 w-6 text-blue-600" />
        <span className="text-lg font-medium text-gray-700">AI Email Agent</span>
      </div>
      <form
        onSubmit={submit}
        className="flex h-12 max-w-2xl flex-1 items-center gap-2 rounded-full bg-[#e9eef6] px-4 focus-within:bg-white focus-within:shadow"
      >
        <Search className="h-5 w-5 text-gray-600" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search mail"
          aria-label="Search mail"
          className="flex-1 bg-transparent text-base outline-none"
        />
        {text && (
          <IconButton
            label="Clear search"
            onClick={() => {
              setText('');
              showList({ kind: 'view', view: 'inbox' });
            }}
          >
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </form>
      <div className="ml-auto flex items-center gap-1">
        {account && <SyncIndicator />}
        <IconButton label="Check for new mail" onClick={() => refresh.mutate()} disabled={!account}>
          <RefreshCw className={`h-5 w-5 ${refresh.isPending ? 'animate-spin' : ''}`} />
        </IconButton>
        <IconButton
          label={chatOpen ? 'Close assistant' : 'Open assistant'}
          onClick={toggleChat}
          active={chatOpen}
        >
          <MessageSquare className="h-5 w-5" />
        </IconButton>
        {account && (
          <Menu.Root>
            <Menu.Trigger asChild>
              <button
                type="button"
                title={account.email}
                className="ml-2 flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 font-medium text-white"
              >
                {(account.displayName ?? account.email).charAt(0).toUpperCase()}
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                align="end"
                sideOffset={8}
                className="z-50 min-w-60 rounded-xl border bg-white p-2 shadow-lg"
              >
                <div className="px-3 py-2">
                  <div className="font-medium">{account.displayName}</div>
                  <div className="text-sm text-gray-600">{account.email}</div>
                </div>
                <Menu.Separator className="my-1 h-px bg-gray-200" />
                <Menu.Item
                  onSelect={() => logout.mutate()}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none hover:bg-gray-100"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
      </div>
    </header>
  );
}
