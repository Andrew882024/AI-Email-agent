import { create } from 'zustand';
import type { SyncPhase, View } from './api/types';
import { baseFor, formatHash, parseHash } from './lib/routes';

export type Route =
  | {
      kind: 'mail';
      view: View;
      /** Label id; `labelName` is what the URL shows. */
      label?: string;
      labelName?: string;
      query?: string;
    }
  | { kind: 'todos' };

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface ComposeAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentBase64: string;
}

export interface ComposeDraft {
  id: number;
  mode: ComposeMode;
  /** The email being replied to / forwarded. */
  sourceMessageId?: string;
  /** Recipients of a reply, for display (the server computes the real ones). */
  replyPreview?: string;
  to: string;
  cc: string;
  bcc: string;
  showCc: boolean;
  subject: string;
  body: string;
  attachments: ComposeAttachment[];
  minimized: boolean;
  sending: boolean;
  error?: string;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

interface UiState {
  // Where we are. The URL hash is the source of truth (see useHashRouter): the actions below
  // change the hash, and applyLocation mirrors it here.
  route: Route;
  /** 1-based page of the list. */
  page: number;
  /** Known page cursors of the current route: cursors[i] loads page i + 1 (undefined = first). */
  cursors: (string | undefined)[];
  openThreadId?: string;
  /** Selected thread ids in the list. */
  selected: string[];
  composes: ComposeDraft[];
  chatOpen: boolean;
  /** The assistant conversation shown in the chat panel. */
  chatSessionId?: string;
  toasts: Toast[];
  sync: { phase: SyncPhase; synced?: number; error?: string };
  reauthRequired: boolean;

  navigate(route: Route): void;
  openThread(threadId: string | undefined): void;
  nextPage(cursor: string): void;
  prevPage(): void;
  applyLocation(route: Route, page: number, threadId: string | undefined): void;
  setCursors(cursors: (string | undefined)[]): void;
  toggleSelected(threadId: string): void;
  setSelected(threadIds: string[]): void;
  openCompose(draft: Partial<ComposeDraft> & { mode: ComposeMode }): void;
  updateCompose(id: number, patch: Partial<ComposeDraft>): void;
  closeCompose(id: number): void;
  toggleChat(): void;
  setChatSession(id: string | undefined): void;
  toast(message: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
  setSync(sync: UiState['sync']): void;
  setReauthRequired(value: boolean): void;
}

let nextId = 1;

/** Go to a hash; the hashchange is what updates the state (so Back/Forward work the same way). */
function go(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
}

const routeKey = (r: Route) =>
  r.kind === 'todos' ? 'todos' : `${r.view}|${r.label ?? ''}|${r.query ?? ''}`;

export const useUi = create<UiState>()((set) => ({
  route: { kind: 'mail', view: 'inbox' },
  page: 1,
  cursors: [undefined],
  selected: [],
  composes: [],
  chatOpen: false,
  toasts: [],
  sync: { phase: 'idle' },
  reauthRequired: false,

  navigate: (route) => go(formatHash({ base: baseFor(route), page: 1 })),
  openThread: (threadId) => go(formatHash({ ...parseHash(window.location.hash), threadId })),
  nextPage: (cursor) => {
    const { page, cursors } = useUi.getState();
    set({ cursors: [...cursors.slice(0, page), cursor] });
    go(formatHash({ base: parseHash(window.location.hash).base, page: page + 1 }));
  },
  prevPage: () => {
    const { page } = useUi.getState();
    go(formatHash({ base: parseHash(window.location.hash).base, page: Math.max(1, page - 1) }));
  },
  applyLocation: (route, page, openThreadId) =>
    set((s) => {
      const sameRoute = routeKey(s.route) === routeKey(route);
      if (
        sameRoute &&
        s.page === page &&
        s.openThreadId === openThreadId &&
        (route.kind !== 'mail' || s.route.kind !== 'mail' || route.labelName === s.route.labelName)
      )
        return {};
      return {
        route,
        page,
        openThreadId,
        cursors: sameRoute ? s.cursors : [undefined],
        selected: [],
      };
    }),
  setCursors: (cursors) => set({ cursors }),
  toggleSelected: (threadId) =>
    set((s) => ({
      selected: s.selected.includes(threadId)
        ? s.selected.filter((id) => id !== threadId)
        : [...s.selected, threadId],
    })),
  setSelected: (selected) => set({ selected }),
  openCompose: (draft) =>
    set((s) => ({
      composes: [
        // Expand the new window, minimize the others (like Gmail).
        ...s.composes.map((c) => ({ ...c, minimized: true })),
        {
          to: '',
          cc: '',
          bcc: '',
          showCc: false,
          subject: '',
          body: '',
          attachments: [],
          minimized: false,
          sending: false,
          ...draft,
          id: nextId++,
        },
      ].slice(-3),
    })),
  updateCompose: (id, patch) =>
    set((s) => ({ composes: s.composes.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  closeCompose: (id) => set((s) => ({ composes: s.composes.filter((c) => c.id !== id) })),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setChatSession: (chatSessionId) => set({ chatSessionId }),
  toast: (message, kind = 'info') =>
    set((s) => ({ toasts: [...s.toasts, { id: nextId++, message, kind }].slice(-4) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setSync: (sync) => set({ sync }),
  setReauthRequired: (reauthRequired) => set({ reauthRequired }),
}));
