import type { Label, View } from '../api/types';
import type { Route } from '../store';

// Gmail-style locations in the URL hash:
//   #inbox  #starred  #sent  #archived  #all  #todos
//   #label/Internship+Applications   #search/internship+offer
//   #inbox/p2 (page 2)   #inbox/<threadId>   #label/Bills/p3/<threadId>

const VIEWS: readonly View[] = [
  'inbox',
  'starred',
  'unread',
  'sent',
  'drafts',
  'archived',
  'all',
  'trash',
  'spam',
];

export interface HashLocation {
  /** "inbox", "todos", "label/<name>" or "search/<query>", with the segment encoded. */
  base: string;
  /** 1-based page of the list. */
  page: number;
  threadId?: string;
}

/** Like Gmail: spaces become "+", everything else is percent-encoded (including "/" in names). */
export const encodeSegment = (text: string) => encodeURIComponent(text).replace(/%20/g, '+');

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' '));
  } catch {
    return segment;
  }
}

/** Any hash, made canonical; unknown locations become the inbox. */
export function parseHash(hash: string): HashLocation {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const head = parts.shift() ?? 'inbox';
  let base: string;
  if ((head === 'label' || head === 'search') && parts.length > 0) {
    base = `${head}/${encodeSegment(decodeSegment(parts.shift()!))}`;
  } else if (head === 'todos' || VIEWS.includes(head as View)) {
    base = head;
  } else {
    return { base: 'inbox', page: 1 };
  }
  let page = 1;
  const pageMatch = /^p(\d+)$/.exec(parts[0] ?? '');
  if (pageMatch) {
    page = Math.max(1, Number(pageMatch[1]));
    parts.shift();
  }
  const threadId = parts[0] && /^[\w-]+$/.test(parts[0]) ? parts[0] : undefined;
  return threadId ? { base, page, threadId } : { base, page };
}

export function formatHash(location: HashLocation): string {
  const page = location.page > 1 ? `/p${location.page}` : '';
  const thread = location.threadId ? `/${location.threadId}` : '';
  return `#${location.base}${page}${thread}`;
}

/** The hash base of a route (labels by name, like Gmail). */
export function baseFor(route: Route): string {
  if (route.kind === 'todos') return 'todos';
  if (route.query) return `search/${encodeSegment(route.query)}`;
  if (route.label) return `label/${encodeSegment(route.labelName ?? route.label)}`;
  return route.view;
}

/**
 * The route of a hash base. Label names resolve against the label list (case-insensitive, then by
 * id): 'loading' until it is available, undefined when no such label exists.
 */
export function routeFor(
  base: string,
  labels: Pick<Label, 'id' | 'name'>[] | undefined,
): Route | 'loading' | undefined {
  if (base === 'todos') return { kind: 'todos' };
  if (base.startsWith('search/'))
    return { kind: 'mail', view: 'all', query: decodeSegment(base.slice('search/'.length)) };
  if (base.startsWith('label/')) {
    if (!labels) return 'loading';
    const name = decodeSegment(base.slice('label/'.length)).toLowerCase();
    const label =
      labels.find((l) => l.name.toLowerCase() === name) ??
      labels.find((l) => l.id.toLowerCase() === name);
    return label && { kind: 'mail', view: 'all', label: label.id, labelName: label.name };
  }
  return { kind: 'mail', view: base as View };
}
