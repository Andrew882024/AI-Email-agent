// Hooks for the global UI state (store.ts). Components use these, never the store itself.
import { useUi } from './store';

export type { ComposeAttachment, ComposeDraft, ComposeMode, Toast } from './store';

/** Show a message at the bottom of the screen. */
export function useToast() {
  return useUi((s) => s.toast);
}

/** The messages on screen, and dismissing one. */
export function useToasts() {
  return { toasts: useUi((s) => s.toasts), dismiss: useUi((s) => s.dismissToast) };
}

/** The open compose windows. */
export function useComposes() {
  return useUi((s) => s.composes);
}

/** Open, edit and close compose windows. */
export function useComposeActions() {
  return {
    open: useUi((s) => s.openCompose),
    update: useUi((s) => s.updateCompose),
    close: useUi((s) => s.closeCompose),
  };
}

/** The assistant panel: whether it's open and which conversation it shows. */
export function useChatPanel() {
  return {
    open: useUi((s) => s.chatOpen),
    toggle: useUi((s) => s.toggleChat),
    sessionId: useUi((s) => s.chatSessionId),
    setSessionId: useUi((s) => s.setChatSession),
  };
}

/** Conversations checked in the list. */
export function useSelection() {
  return {
    selected: useUi((s) => s.selected),
    toggle: useUi((s) => s.toggleSelected),
    set: useUi((s) => s.setSelected),
  };
}
