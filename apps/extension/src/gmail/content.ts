// Runs inside Gmail (mail.google.com). Opens the assistant's drafts in Gmail's own compose window:
// a new email through the Compose button, a reply or forward from the conversation's Reply /
// Reply all / Forward buttons, so Gmail threads it. Gmail's markup isn't an API; the selectors
// below are ones Gmail has kept for years, and when one stops matching, the side panel falls back
// to Gmail's compose page. Chrome loads this as a single classic script: type imports only.
import type { GmailDraft, GmailRequest, GmailResponse } from './messages';

const TIMEOUT_MS = 8000;

const SELECTORS = {
  composeButton: 'div[gh="cm"]',
  subject: 'input[name="subjectbox"]',
  editor: 'div[contenteditable="true"][role="textbox"]',
  to: '[name="to"] input, input[name="to"], textarea[name="to"]',
  cc: '[name="cc"] input, input[name="cc"], textarea[name="cc"]',
  // The buttons under the last message of an open conversation.
  reply: 'span.ams.bkH',
  replyAll: 'span.ams.bkI',
  forward: 'span.ams.bkG',
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gmail keeps views it has left in the page, hidden; only what's on screen counts. */
const visible = (el: Element) => el.getClientRects().length > 0;

const visibleAll = <T extends Element>(selector: string, root: ParentNode = document): T[] =>
  [...root.querySelectorAll<T>(selector)].filter(visible);

/** Poll until `find` returns something, or fail with `what`. */
async function waitFor<T>(what: string, find: () => T | undefined, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Gmail didn't show ${what}`);
    await sleep(100);
  }
}

/** Gmail's buttons act on the mouse events, not on click() alone. */
function press(el: Element) {
  for (const type of ['mousedown', 'mouseup', 'click'])
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
}

/** Type into a field the way a user would, so Gmail's own handlers see it. */
function typeInto(el: HTMLElement, text: string, { replace }: { replace: boolean }) {
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  } else {
    // A message body: write at the top, above a quoted or forwarded message.
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  document.execCommand('insertText', false, text);
}

/** The compose window around a message body: the nearest ancestor that also has the To field. */
function composeRoot(editor: HTMLElement): HTMLElement {
  let el: HTMLElement | null = editor;
  for (let depth = 0; el && depth < 30; depth++, el = el.parentElement) {
    if (el.querySelector(SELECTORS.to) || el.querySelector(SELECTORS.subject)) return el;
  }
  return editor.parentElement ?? editor;
}

/** Wait for a message body that wasn't on screen before (the compose window just opened). */
async function newEditor(before: Set<Element>): Promise<HTMLElement> {
  return waitFor('a compose window', () =>
    visibleAll<HTMLElement>(SELECTORS.editor).find((el) => !before.has(el)),
  );
}

/** Add addresses to a recipients field; Gmail turns each into a chip at the comma. */
function addRecipients(field: HTMLElement, addresses: string[]) {
  typeInto(field, `${addresses.join(', ')}, `, { replace: false });
  field.dispatchEvent(new FocusEvent('blur'));
}

/** Show the Cc field (it starts hidden) and return it. */
async function ccField(root: HTMLElement): Promise<HTMLElement | undefined> {
  const shown = visibleAll<HTMLElement>(SELECTORS.cc, root)[0];
  if (shown) return shown;
  const toggle = [...root.querySelectorAll<HTMLElement>('[role="link"], span')].find(
    (el) => visible(el) && el.textContent?.trim() === 'Cc',
  );
  if (!toggle) return undefined;
  press(toggle);
  return waitFor('the Cc field', () => visibleAll<HTMLElement>(SELECTORS.cc, root)[0], 2000).catch(
    () => undefined,
  );
}

/** Fill recipients, subject and body; return what couldn't be filled. */
async function fill(
  editor: HTMLElement,
  draft: GmailDraft,
  fields: { recipients: boolean; subject: boolean },
): Promise<string[]> {
  const warnings: string[] = [];
  const root = composeRoot(editor);
  if (fields.recipients && draft.to.length) {
    const to = visibleAll<HTMLElement>(SELECTORS.to, root)[0];
    if (to) addRecipients(to, draft.to);
    else warnings.push(`Add the recipients yourself: ${draft.to.join(', ')}`);
  }
  if (fields.recipients && draft.cc.length) {
    const cc = await ccField(root);
    if (cc) addRecipients(cc, draft.cc);
    else warnings.push(`Add Cc yourself: ${draft.cc.join(', ')}`);
  }
  if (fields.subject && draft.subject) {
    const subject = root.querySelector<HTMLInputElement>(SELECTORS.subject);
    if (subject) typeInto(subject, draft.subject, { replace: true });
    else warnings.push(`Add the subject yourself: ${draft.subject}`);
  }
  // Body last, so the cursor ends up in it.
  typeInto(editor, draft.mode === 'forward' ? `${draft.body}\n\n` : draft.body, { replace: false });
  return warnings;
}

async function openNew(draft: GmailDraft): Promise<string[]> {
  const before = new Set(visibleAll(SELECTORS.editor));
  const compose = await waitFor('the Compose button', () => visibleAll(SELECTORS.composeButton)[0]);
  press(compose);
  const editor = await newEditor(before);
  return fill(editor, draft, { recipients: true, subject: true });
}

async function openReply(draft: GmailDraft, threadId: string): Promise<string[]> {
  const button =
    draft.mode === 'reply'
      ? SELECTORS.reply
      : draft.mode === 'replyAll'
        ? SELECTORS.replyAll
        : SELECTORS.forward;
  const old = new Set(document.querySelectorAll(button));
  location.hash = `#all/${encodeURIComponent(threadId)}`;
  await sleep(300); // let Gmail start switching views
  // A fresh button belongs to the conversation just opened; an old one that is still on screen
  // means it already was open. Reply all is missing when there's only one other person.
  const target = await waitFor('the conversation', () => {
    const shown = visibleAll(button);
    const fallback = draft.mode === 'replyAll' ? visibleAll(SELECTORS.reply) : [];
    return shown.find((b) => !old.has(b)) ?? shown[0] ?? fallback[0];
  });
  const before = new Set(visibleAll(SELECTORS.editor));
  press(target);
  const editor = await newEditor(before);
  // Gmail fills in a reply's recipients and subject itself; a forward needs its recipients.
  return fill(editor, draft, { recipients: draft.mode === 'forward', subject: false });
}

async function openDraft(draft: GmailDraft, threadId: string | undefined): Promise<GmailResponse> {
  try {
    if (draft.mode === 'new') return { ok: true, warnings: await openNew(draft) };
    if (!threadId) return { ok: false, error: "Couldn't find the email being replied to" };
    return { ok: true, warnings: await openReply(draft, threadId) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((message: GmailRequest, _sender, sendResponse) => {
  if (message?.type !== 'open_draft') return false;
  void openDraft(message.draft, message.threadId).then(sendResponse);
  return true; // answers asynchronously
});
