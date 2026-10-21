import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { threadsQuery, useLabels } from './api/queries';
import { formatHash, parseHash, routeFor } from './lib/routes';
import { type Route, useUi } from './store';

/** Mirror the URL hash into the store, so Back/Forward, reload and shared links work like Gmail. */
export function useHashRouter(): void {
  const labels = useLabels();
  const applyLocation = useUi((s) => s.applyLocation);
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    const location = parseHash(hash);
    const route = routeFor(location.base, labels.data);
    if (route === 'loading' && !labels.isError) return; // label names resolve once labels load
    if (route === undefined || route === 'loading') {
      window.location.replace('#inbox'); // no such label
      return;
    }
    applyLocation(route, location.page, location.threadId);
    const canonical = formatHash(location);
    if (canonical !== hash) window.history.replaceState(null, '', canonical);
  }, [hash, labels.data, labels.isError, applyLocation]);
}

/**
 * The cursor of a list page. Pages are cursor-based, so opening #inbox/p3 directly (reload, a
 * link) fetches pages 1 and 2 first to learn it; a page past the end lands on the last page.
 */
export function usePageCursor(
  route: Extract<Route, { kind: 'mail' }>,
  page: number,
): { cursor: string | undefined; ready: boolean } {
  const qc = useQueryClient();
  const cursors = useUi((s) => s.cursors);
  const setCursors = useUi((s) => s.setCursors);
  const toast = useUi((s) => s.toast);
  const ready = page <= cursors.length;

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    const goToPage = (n: number) =>
      window.location.replace(formatHash({ ...parseHash(window.location.hash), page: n }));
    void (async () => {
      const known = [...cursors];
      while (known.length < page) {
        const data = await qc.fetchQuery(threadsQuery(route, known.at(-1)));
        if (cancelled) return;
        if (!data.nextCursor) break;
        known.push(data.nextCursor);
      }
      setCursors(known);
      if (known.length < page) goToPage(known.length);
    })().catch((err: unknown) => {
      if (cancelled) return;
      toast(
        `Couldn't load page ${page}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      goToPage(1);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, page, route, cursors, qc, setCursors, toast]);

  return { cursor: ready ? cursors[page - 1] : undefined, ready };
}
