import {
  keepPreviousData,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  createLabel,
  getThread,
  listLabels,
  listThreads,
  listTodos,
  type MailToolName,
  runMailTool,
  type Thread,
  type ThreadPage,
  type ThreadSummary,
  type View,
} from '../api/mail';
import { showPage } from '../router/mail-params';
import { applyToMessage, applyToThread, belongsInList, labelChangeFor } from './optimistic';
import { useUi } from './store';

export const PAGE_SIZE = 50;

/** A thread list as the server takes it (the mail page resolves label names to ids). */
export interface MailboxQuery {
  view: View;
  /** Label id. */
  label?: string;
  labelName?: string;
  query?: string;
}

const listKey = (q: MailboxQuery) => `${q.view}|${q.label ?? ''}|${q.query ?? ''}`;

/** One page of a thread list (shared by the list and by page-cursor lookups). */
const threadsQuery = (list: MailboxQuery, cursor: string | undefined) => ({
  queryKey: ['threads', list.view, list.label, list.query, cursor],
  queryFn: () =>
    listThreads({
      view: list.view,
      label: list.label,
      query: list.query,
      limit: PAGE_SIZE,
      cursor,
    }),
});

export function useThreads(list: MailboxQuery, cursor: string | undefined, enabled = true) {
  return useQuery({ ...threadsQuery(list, cursor), enabled, placeholderData: keepPreviousData });
}

export function useThread(threadId: string) {
  return useQuery({ queryKey: ['thread', threadId], queryFn: () => getThread(threadId) });
}

export function useLabels() {
  return useQuery({ queryKey: ['labels'], queryFn: listLabels });
}

export function useTodos() {
  return useQuery({ queryKey: ['todos'], queryFn: listTodos });
}

/** Reload the thread lists now. */
export function useRefreshThreads() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['threads'] });
}

const FIRST_PAGE = [undefined];

/**
 * The cursor of a list page. Pages are cursor-based, so opening page 4 directly (a reload, a link)
 * fetches pages 1-3 first to learn it; a page past the end goes to the last page.
 * `rememberNext` stores the next page's cursor so going there needs no extra requests.
 */
export function usePageCursor(list: MailboxQuery, page: number) {
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

  return {
    cursor: ready ? cursors[page - 1] : undefined,
    ready,
    rememberNext: (next: string) => setCursors(key, [...cursors.slice(0, page), next]),
  };
}

interface ToolCall {
  name: MailToolName;
  input: Record<string, unknown>;
  /** Don't toast on failure (e.g. background mark-as-read). */
  silent?: boolean;
}

/**
 * Run a mailbox tool. Label-changing tools update every cached list and thread immediately
 * (and drop threads that no longer belong in the list shown), rolling back if the call fails.
 */
export function useMailTool() {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: ({ name, input }: ToolCall) => runMailTool(name, input),
    onMutate: async ({ name, input }) => {
      const change = labelChangeFor(name, input);
      if (!change) return { snapshots: [] as [QueryKey, unknown][] };
      await qc.cancelQueries({ queryKey: ['threads'] });
      await qc.cancelQueries({ queryKey: ['thread'] });
      const lists = qc.getQueriesData<ThreadPage>({ queryKey: ['threads'] });
      const threads = qc.getQueriesData<Thread>({ queryKey: ['thread'] });
      for (const [key, data] of lists) {
        if (!data) continue;
        const [, view, label] = key as [string, View, string | undefined];
        qc.setQueryData(key, {
          ...data,
          items: data.items
            .map((t) => applyToThread(t, change))
            .filter((t) => belongsInList(t, view, label)),
        });
      }
      for (const [key, data] of threads) {
        if (data)
          qc.setQueryData(key, {
            ...data,
            messages: data.messages.map((m) => applyToMessage(m, change)),
          });
      }
      return { snapshots: [...lists, ...threads] as [QueryKey, unknown][] };
    },
    onError: (err, call, context) => {
      for (const [key, data] of context?.snapshots ?? []) qc.setQueryData(key, data);
      if (!call.silent) toast(err instanceof Error ? err.message : String(err), 'error');
    },
    onSettled: (_data, _err, { name }) => {
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['thread'] });
      void qc.invalidateQueries({ queryKey: ['labels'] });
      if (name.includes('todo')) void qc.invalidateQueries({ queryKey: ['todos'] });
    },
  });
}

/** Add a todo for each thread, attached to its newest message. */
export function useAddTodos() {
  const tool = useMailTool();
  const toast = useUi((s) => s.toast);
  return async (threads: ThreadSummary[]) => {
    await Promise.all(
      threads.map((t) =>
        tool.mutateAsync({ name: 'add_todo', input: { messageId: t.messageIds.at(-1)! } }),
      ),
    ).then(
      () => toast(threads.length === 1 ? 'Added to Todos' : `Added ${threads.length} todos`),
      () => {}, // useMailTool already reported the error
    );
  };
}

/** Create a label (the label list reloads). */
export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createLabel,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['labels'] }),
  });
}

/** Send, reply or forward (queued for Gmail; the sync status shows it until sent). */
export function useSendMail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, input }: { name: MailToolName; input: Record<string, unknown> }) =>
      runMailTool(name, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sync'] }),
  });
}
