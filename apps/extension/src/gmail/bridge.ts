// The side panel's side of Gmail: find the Gmail tab the panel sits next to, show a conversation
// in it, and open the assistant's drafts in Gmail's own compose window (through the content
// script), falling back to Gmail's compose page in a new tab when that doesn't work.
import { getMessageThreadId } from '../api/mail';
import { GMAIL_ORIGIN } from '../config';
import type { GmailDraft, GmailRequest, GmailResponse } from './messages';

/** The active Gmail tab of this window, and its account's base URL (…/mail/u/<n>/). */
async function gmailTab(): Promise<{ id: number; index: number; base: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(`${GMAIL_ORIGIN}/`))
    throw new Error('Open Gmail in this tab first');
  const base = /^https:\/\/mail\.google\.com\/mail\/u\/\d+\//.exec(tab.url)?.[0];
  return { id: tab.id, index: tab.index, base: base ?? `${GMAIL_ORIGIN}/mail/u/0/` };
}

/** Show a conversation (Gmail thread id) in the Gmail tab. */
export async function openThreadInGmail(threadId: string): Promise<void> {
  const tab = await gmailTab();
  await chrome.tabs.update(tab.id, { url: `${tab.base}#all/${encodeURIComponent(threadId)}` });
}

/** Gmail's full-page compose, prefilled. Not threaded: a reply sent from here is a new email. */
function composeUrl(base: string, draft: GmailDraft): string {
  const params = new URLSearchParams({ view: 'cm', fs: '1' });
  if (draft.to.length) params.set('to', draft.to.join(','));
  if (draft.cc.length) params.set('cc', draft.cc.join(','));
  if (draft.subject) params.set('su', draft.subject);
  if (draft.body) params.set('body', draft.body);
  return `${base}?${params.toString()}`;
}

export type DraftOutcome =
  | { where: 'gmail'; warnings: string[] }
  /** `unthreaded`: a reply or forward that Gmail will send as a new conversation. */
  | { where: 'new_tab'; reason: string; unthreaded: boolean };

/**
 * Open the draft in Gmail's compose window in the Gmail tab; if the content script can't (not
 * loaded yet, or Gmail's page changed), open Gmail's compose page in a new tab instead.
 */
export async function openDraftInGmail(draft: GmailDraft): Promise<DraftOutcome> {
  const tab = await gmailTab();
  let reason: string;
  try {
    const threadId =
      draft.mode !== 'new' && draft.sourceMessageId
        ? await getMessageThreadId(draft.sourceMessageId)
        : undefined;
    const message: GmailRequest = { type: 'open_draft', draft, threadId };
    const res = (await chrome.tabs.sendMessage(tab.id, message)) as GmailResponse | undefined;
    if (res?.ok) return { where: 'gmail', warnings: res.warnings };
    reason = res?.error ?? 'Gmail did not answer';
  } catch (err) {
    reason =
      err instanceof Error && /receiving end/i.test(err.message)
        ? 'Reload the Gmail tab so the extension can reach it'
        : err instanceof Error
          ? err.message
          : String(err);
  }
  await chrome.tabs.create({ url: composeUrl(tab.base, draft), index: tab.index + 1 });
  return { where: 'new_tab', reason, unthreaded: draft.mode !== 'new' };
}
