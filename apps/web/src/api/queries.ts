import {
  keepPreviousData,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type Route, useUi } from '../store';
import { api, callTool, query } from './client';
import { applyToMessage, applyToThread, belongsInList, labelChangeFor } from './optimistic';
import type {
  AuthStatus,
  Label,
  Page,
  SyncStatus,
  Thread,
  ThreadSummary,
  Todo,
  View,
} from './types';

export const PAGE_SIZE = 25;

export function useAuthStatus() {
  return useQuery({ queryKey: ['auth'], queryFn: () => api<AuthStatus>('/api/auth/status') });
}

export function useThreads(route: Extract<Route, { kind: 'mail' }>, cursor: string | undefined) {
  return useQuery({
    queryKey: ['threads', route.view, route.label, route.query, cursor],
    queryFn: () =>
      api<Page<ThreadSummary>>(
        `/api/threads${query({ view: route.view, label: route.label, q: route.query, limit: PAGE_SIZE, cursor })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useThread(threadId: string) {
  return useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api<Thread>(`/api/threads/${encodeURIComponent(threadId)}`),
  });
}

export function useLabels() {
  return useQuery({ queryKey: ['labels'], queryFn: () => api<Label[]>('/api/labels') });
}

export function useTodos() {
  return useQuery({ queryKey: ['todos'], queryFn: () => api<Todo[]>('/api/todos') });
}

export function useSyncStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['sync'],
    queryFn: () => api<SyncStatus>('/api/sync/status'),
    enabled,
    refetchInterval: 15_000,
  });
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Don't toast on failure (e.g. background mark-as-read). */
  silent?: boolean;
}

/**
 * Run a mailbox tool. Label-changing tools update every cached list and thread immediately
 * (and drop threads that no longer belong in the list shown), rolling back if the call fails.
 */
export function useTool() {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: ({ name, input }: ToolCall) => callTool(name, input),
    onMutate: async ({ name, input }) => {
      const change = labelChangeFor(name, input);
      if (!change) return { snapshots: [] as [QueryKey, unknown][] };
      await qc.cancelQueries({ queryKey: ['threads'] });
      await qc.cancelQueries({ queryKey: ['thread'] });
      const lists = qc.getQueriesData<Page<ThreadSummary>>({ queryKey: ['threads'] });
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
