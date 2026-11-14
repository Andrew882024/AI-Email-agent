import { useUi } from './store';

export type { Toast } from './store';

/** Show a short message at the bottom of the panel. */
export function useToast() {
  return useUi((s) => s.toast);
}

/** The messages on screen, and dismissing one. */
export function useToasts() {
  return { toasts: useUi((s) => s.toasts), dismiss: useUi((s) => s.dismissToast) };
}

/** Which conversation the panel shows. */
export function useChatPanel() {
  return {
    sessionId: useUi((s) => s.chatSessionId),
    setSessionId: useUi((s) => s.setChatSession),
  };
}
