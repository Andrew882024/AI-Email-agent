import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { listKey, type MailboxQuery, threadsQuery } from '../../api/queries';
import { showPage } from '../../router/mail-params';
import { useUi } from '../../store';

const FIRST_PAGE = [undefined];

/**
 * The cursor of a list page. Pages are cursor-based, so opening page 4 directly (a reload, a link)
 * fetches pages 1-3 first to learn it; a page past the end goes to the last page.
 */
export function usePageCursor(
  list: MailboxQuery,
  page: number,
): { cursor: string | undefined; ready: boolean } {
  const qc = useQueryClient();
  const key = listKey(list);
  const cursors = useUi((s) => s.cursors[key]) ?? FIRST_PAGE;
  const setCursors = useUi((s) => s.setCursors);
  const toast = useUi((s) => s.toast);
  const ready = page <= cursors.length;

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void (async () => {
      const known = [...cursors];
      while (known.length < page) {
        const data = await qc.fetchQuery(threadsQuery(list, known.at(-1)));
        if (cancelled) return;
        if (!data.nextCursor) break;
        known.push(data.nextCursor);
      }
      setCursors(key, known);
      if (known.length < page) showPage(known.length, { replace: true });
    })().catch((err: unknown) => {
      if (cancelled) return;
      toast(
        `Couldn't load page ${page}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      showPage(1, { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [ready, page, list, key, cursors, qc, setCursors, toast]);

  return { cursor: ready ? cursors[page - 1] : undefined, ready };
}
