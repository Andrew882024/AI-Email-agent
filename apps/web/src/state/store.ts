import { create } from 'zustand';
import type { SyncPhase } from '../api/sync';

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

// UI state that isn't in the URL. Where the user is (page, list, conversation) is only in the URL:
// see router/routes.tsx.
interface UiState {
  /** Known page cursors per list (key from listKey): cursors[i] loads page i + 1. */
  cursors: Record<string, (string | undefined)[]>;
  /** Selected thread ids in the list. */
  selected: string[];
  composes: ComposeDraft[];
  chatOpen: boolean;
  /** The assistant conversation shown in the chat panel. */
  chatSessionId?: string;
  toasts: Toast[];
  sync: { phase: SyncPhase; synced?: number; error?: string };
  reauthRequired: boolean;

  setCursors(listKey: string, cursors: (string | undefined)[]): void;
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
  cursors: {},
  selected: [],
  composes: [],
  chatOpen: false,
  toasts: [],
  sync: { phase: 'idle' },
  reauthRequired: false,

  setCursors: (listKey, cursors) => set((s) => ({ cursors: { ...s.cursors, [listKey]: cursors } })),
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
