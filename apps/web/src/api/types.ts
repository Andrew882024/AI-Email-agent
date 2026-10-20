// Shapes returned by the server (JSON, so dates are ISO strings).

export type View =
  'inbox' | 'starred' | 'unread' | 'sent' | 'drafts' | 'archived' | 'all' | 'trash' | 'spam';

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ThreadSummary {
  threadId: string;
  subject: string;
  snippet: string;
  lastMessageAt: string;
  messageCount: number;
  participants: EmailAddress[];
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  hasAttachments: boolean;
  messageIds: string[];
}

export interface Attachment {
  partId: string;
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
}

export interface Message {
  id: string;
  threadId: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  snippet: string;
  internalDate: string;
  hasAttachments: boolean;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  bodyText?: string;
  bodyHtml?: string;
  attachments: Attachment[];
}

export interface Thread {
  threadId: string;
  messages: Message[];
}

export interface Label {
  id: string;
  name: string;
  type: 'system' | 'user';
  color?: { background: string; text: string };
  total: number;
  unread: number;
}

export interface Todo {
  id: string;
  messageId?: string;
  googleTaskId?: string;
  title: string;
  status: 'needsAction' | 'completed';
  due?: string;
  completedAt?: string;
  createdAt: string;
  message?: { id: string; threadId: string; subject: string; from?: EmailAddress };
}

export interface AuthStatus {
  account: { id: string; email: string; displayName?: string } | null;
  connected: boolean;
}

export interface SyncStatus {
  historyId?: string;
  lastFullSyncAt?: string;
  fullSync?: { synced: number };
  outboxPending: number;
}

export type SyncPhase = 'idle' | 'full_sync' | 'incremental' | 'error' | 'reauth_required';
