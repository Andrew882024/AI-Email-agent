import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

// Side panel UI state that isn't server data.
interface UiState {
  /** The assistant conversation shown. */
  chatSessionId?: string;
  toasts: Toast[];

  setChatSession(id: string | undefined): void;
  toast(message: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
}

let nextId = 1;

export const useUi = create<UiState>()((set) => ({
  toasts: [],

  setChatSession: (chatSessionId) => set({ chatSessionId }),
  toast: (message, kind = 'info') =>
    set((s) => ({ toasts: [...s.toasts, { id: nextId++, message, kind }].slice(-4) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
