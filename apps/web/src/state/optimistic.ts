// Pure helpers that predict the effect of a label-changing tool, so the UI updates instantly.
import type { Message, ThreadSummary, View } from '../api/mail';

export interface LabelChange {
  messageIds: string[];
  add: string[];
  remove: string[];
}

/** The label change a tool call will make, or undefined for tools that don't change labels. */
export function labelChangeFor(
  tool: string,
  input: Record<string, unknown>,
): LabelChange | undefined {
  const messageIds = (input.messageIds as string[] | undefined) ?? [];
  const label = input.label as string | undefined;
  switch (tool) {
    case 'mark_read':
      return { messageIds, add: [], remove: ['UNREAD'] };
    case 'mark_unread':
      return { messageIds, add: ['UNREAD'], remove: [] };
    case 'star':
      return { messageIds, add: ['STARRED'], remove: [] };
    case 'unstar':
      return { messageIds, add: [], remove: ['STARRED'] };
    case 'archive':
      return { messageIds, add: [], remove: ['INBOX'] };
    case 'move_to_inbox':
      return { messageIds, add: ['INBOX'], remove: [] };
    case 'add_label':
      return label ? { messageIds, add: [label], remove: [] } : undefined;
    case 'remove_label':
      return label ? { messageIds, add: [], remove: [label] } : undefined;
    default:
      return undefined;
  }
}

function relabel(labels: string[], change: LabelChange): string[] {
  const next = new Set(labels.filter((l) => !change.remove.includes(l)));
  change.add.forEach((l) => next.add(l));
  return [...next].sort();
}

export function applyToMessage(message: Message, change: LabelChange): Message {
  if (!change.messageIds.includes(message.id)) return message;
  const labelIds = relabel(message.labelIds, change);
  return {
    ...message,
    labelIds,
    isRead: !labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
    inInbox: labelIds.includes('INBOX'),
  };
}

/** UI actions target whole threads, so the change applies to the thread's label union. */
export function applyToThread(thread: ThreadSummary, change: LabelChange): ThreadSummary {
  if (!thread.messageIds.some((id) => change.messageIds.includes(id))) return thread;
  const labelIds = relabel(thread.labelIds, change);
  return {
    ...thread,
    labelIds,
    isRead: !labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
    inInbox: labelIds.includes('INBOX'),
  };
}

/** Whether a (possibly just changed) thread still belongs in the list being shown. */
export function belongsInList(thread: ThreadSummary, view: View, label?: string): boolean {
  if (label && !thread.labelIds.includes(label)) return false;
  switch (view) {
    case 'inbox':
      return thread.labelIds.includes('INBOX');
    case 'starred':
      return thread.isStarred;
    case 'unread':
      return !thread.isRead;
    case 'archived':
      return !thread.labelIds.includes('INBOX');
    default:
      return true;
  }
}
