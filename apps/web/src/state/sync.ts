import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { connectServerEvents } from '../api/events';
import { getSyncStatus, syncNow } from '../api/sync';
import { useUi } from './store';

/** Sync state: `status` from the server (polled), `live` from the event stream. */
export function useSyncStatus() {
  const status = useQuery({
    queryKey: ['sync'],
    queryFn: getSyncStatus,
    refetchInterval: 15_000,
  });
  return { status, live: useUi((s) => s.sync) };
}

/** Sync with Gmail now. */
export function useSyncNow() {
  return useMutation({ mutationFn: syncNow });
}

/** Keep cached data fresh from the server's event stream (sync, outbox, labels, todos). */
export function useServerEvents(): void {
  const qc = useQueryClient();
  const setSync = useUi((s) => s.setSync);
  const setReauthRequired = useUi((s) => s.setReauthRequired);
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Sync can emit many events in a burst; refetch once they settle.
    const refreshMail = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['threads'] });
        void qc.invalidateQueries({ queryKey: ['thread'] });
        void qc.invalidateQueries({ queryKey: ['labels'] });
      }, 300);
    };
    const close = connectServerEvents({
      mail: refreshMail,
      labels: () => void qc.invalidateQueries({ queryKey: ['labels'] }),
      todos: () => void qc.invalidateQueries({ queryKey: ['todos'] }),
      workflows: () => void qc.invalidateQueries({ queryKey: ['workflows'] }),
      sync: (status) => {
        setSync(status);
        if (status.phase === 'reauth_required') setReauthRequired(true);
        if (status.phase === 'idle') void qc.invalidateQueries({ queryKey: ['sync'] });
      },
      outboxFailed: (failure) => {
        toast(`Couldn't apply a change in Gmail (${failure.op}): ${failure.error}`, 'error');
        refreshMail();
      },
    });
    return () => {
      clearTimeout(timer);
      close();
    };
  }, [qc, setSync, setReauthRequired, toast]);
}
