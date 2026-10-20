import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useUi } from '../store';
import type { SyncPhase } from './types';

/** Keep cached data fresh from the server's event stream (sync, outbox, labels, todos). */
export function useServerEvents(enabled: boolean): void {
  const qc = useQueryClient();
  const setSync = useUi((s) => s.setSync);
  const setReauthRequired = useUi((s) => s.setReauthRequired);
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/events');
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
    const data = <T>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;

    for (const name of ['message.added', 'message.updated', 'message.deleted']) {
      source.addEventListener(name, refreshMail);
    }
    source.addEventListener(
      'labels.changed',
      () => void qc.invalidateQueries({ queryKey: ['labels'] }),
    );
    source.addEventListener(
      'todos.changed',
      () => void qc.invalidateQueries({ queryKey: ['todos'] }),
    );
    source.addEventListener('sync.status', (event) => {
      const status = data<{ phase: SyncPhase; synced?: number; error?: string }>(event);
      setSync(status);
      if (status.phase === 'reauth_required') setReauthRequired(true);
      if (status.phase === 'idle') void qc.invalidateQueries({ queryKey: ['sync'] });
    });
    source.addEventListener('outbox.failed', (event) => {
      const failure = data<{ op: string; error: string }>(event);
      toast(`Couldn't apply a change in Gmail (${failure.op}): ${failure.error}`, 'error');
      refreshMail();
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [enabled, qc, setSync, setReauthRequired, toast]);
}
