import type { View } from '../api/types';
import { navigate } from './location';

// The mail page's parameters live after "#", like Gmail:
//   /mail#inbox  #starred  #sent  #archived  #all  #todos
//   /mail#label/Internship+Applications   /mail#search/internship+offer
//   /mail#inbox/p4 (page 4)   /mail#inbox/p4/1a1374688843c397 (a conversation, opened from page 4)

/** Which list the page shows. Labels go by name, as the user sees them. */
export type MailList =
  | { kind: 'view'; view: View }
  | { kind: 'label'; name: string }
  | { kind: 'search'; query: string }
  | { kind: 'todos' };

export interface MailParams {
  list: MailList;
  /** 1-based page of the list. */
  page: number;
  /** An open conversation, shown instead of the list. */
  threadId?: string;
}

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

const INBOX: MailList = { kind: 'view', view: 'inbox' };

/** Like Gmail: spaces become "+", everything else is percent-encoded (including "/" in names). */
export const encodeSegment = (text: string) => encodeURIComponent(text).replace(/%20/g, '+');

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' '));
  } catch {
    return segment;
  }
}

/** The mail page's parameters from its hash. Anything unrecognized means the inbox. */
export function parseMailHash(hash: string): MailParams {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const head = parts.shift() ?? 'inbox';
  let list: MailList;
  if (head === 'label' && parts.length > 0)
    list = { kind: 'label', name: decodeSegment(parts.shift()!) };
  else if (head === 'search' && parts.length > 0)
    list = { kind: 'search', query: decodeSegment(parts.shift()!) };
  else if (head === 'todos') list = { kind: 'todos' };
  else if (VIEWS.includes(head as View)) list = { kind: 'view', view: head as View };
  else return { list: INBOX, page: 1 };

  let page = 1;
  const pageMatch = /^p(\d+)$/.exec(parts[0] ?? '');
  if (pageMatch) {
    page = Math.max(1, Number(pageMatch[1]));
    parts.shift();
  }
  const threadId = parts[0] && /^[\w-]+$/.test(parts[0]) ? parts[0] : undefined;
  return threadId ? { list, page, threadId } : { list, page };
}

function listSegment(list: MailList): string {
  switch (list.kind) {
    case 'view':
      return list.view;
    case 'label':
      return `label/${encodeSegment(list.name)}`;
    case 'search':
      return `search/${encodeSegment(list.query)}`;
    case 'todos':
      return 'todos';
  }
}

export function formatMailHash(params: MailParams): string {
  const page = params.page > 1 ? `/p${params.page}` : '';
  const thread = params.threadId ? `/${params.threadId}` : '';
  return `#${listSegment(params.list)}${page}${thread}`;
}

/** Same list? (Label names compare case-insensitively, like Gmail.) */
export function sameList(a: MailList, b: MailList): boolean {
  if (a.kind === 'label' && b.kind === 'label')
    return a.name.toLowerCase() === b.name.toLowerCase();
  return listSegment(a) === listSegment(b);
}

// ---- navigation within the mail page (each adds a history entry, so Back/Forward work) ----

const go = (params: MailParams, replace = false) =>
  navigate(`/mail${formatMailHash(params)}`, { replace });
const currentParams = () => parseMailHash(window.location.hash);

/** Show a list, from its first page. `replace` corrects the URL without a history entry. */
export const showList = (list: MailList, options: { replace?: boolean } = {}) =>
  go({ list, page: 1 }, options.replace);

/** Another page of the current list. */
export const showPage = (page: number, options: { replace?: boolean } = {}) =>
  go({ list: currentParams().list, page: Math.max(1, page) }, options.replace);

/** Open a conversation over the current list and page; undefined goes back to the list. */
export const openThread = (threadId: string | undefined) => go({ ...currentParams(), threadId });
