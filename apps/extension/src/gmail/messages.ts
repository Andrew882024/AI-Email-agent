// What the side panel asks the Gmail content script to do, and what it answers.

export interface GmailDraft {
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
  /** Gmail id of the email being replied to / forwarded. */
  sourceMessageId?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

/** `threadId`: the conversation of `draft.sourceMessageId`, for replies and forwards. */
export type GmailRequest = { type: 'open_draft'; draft: GmailDraft; threadId?: string };

/** `ok: false`: nothing usable was opened. `warnings`: opened, but some fields need a manual touch. */
export type GmailResponse = { ok: true; warnings: string[] } | { ok: false; error: string };
