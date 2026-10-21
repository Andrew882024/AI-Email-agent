import { useSyncExternalStore } from 'react';

/** Where the app is: the page's path and that page's parameters after "#". */
export interface AppLocation {
  path: string;
  hash: string;
}

// pushState/replaceState fire no event of their own, so navigate() announces changes with this one.
const NAVIGATE_EVENT = 'app:navigate';

const read = (): AppLocation => ({ path: window.location.pathname, hash: window.location.hash });
let current: AppLocation | undefined;
const listeners = new Set<() => void>();
const update = () => {
  const next = read();
  if (next.path === current?.path && next.hash === current.hash) return;
  current = next;
  listeners.forEach((listener) => listener());
};

function subscribe(listener: () => void) {
  if (listeners.size === 0)
    for (const type of ['popstate', 'hashchange', NAVIGATE_EVENT])
      window.addEventListener(type, update);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0)
      for (const type of ['popstate', 'hashchange', NAVIGATE_EVENT])
        window.removeEventListener(type, update);
  };
}

/** The current location; re-renders on navigate(), Back/Forward and hash edits. */
export function useLocation(): AppLocation {
  return useSyncExternalStore(subscribe, () => (current ??= read()));
}

/** Go to a path (with its "#..." parameters). `replace` doesn't add a history entry. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.href);
  if (url.href === window.location.href) return;
  if (options.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
