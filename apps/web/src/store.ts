import { create } from 'zustand';
import type { SyncPhase, View } from './api/types';

export type Route =
  { kind: 'mail'; view: View; label?: string; query?: string } | { kind: 'todos' };

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
  route: Route;
  /** Cursor of each visited page; the last one is the current page (undefined = first). */
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

export const useUi = create<UiState>()((set) => ({
  route: { kind: 'mail', view: 'inbox' },
  cursors: [undefined],
  selected: [],
  composes: [],
  chatOpen: false,
  toasts: [],
  sync: { phase: 'idle' },
  reauthRequired: false,

  navigate: (route) => set({ route, cursors: [undefined], selected: [], openThreadId: undefined }),
  openThread: (openThreadId) => set({ openThreadId, selected: [] }),
  nextPage: (cursor) => set((s) => ({ cursors: [...s.cursors, cursor], selected: [] })),
  prevPage: () =>
    set((s) => ({
      cursors: s.cursors.length > 1 ? s.cursors.slice(0, -1) : s.cursors,
      selected: [],
    })),
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
