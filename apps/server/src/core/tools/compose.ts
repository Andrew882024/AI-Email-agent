import MailComposer from 'nodemailer/lib/mail-composer';
import type { EmailAddress, Message } from '../domain/types.js';

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Content-ID for inline images referenced from the HTML as cid:... */
  cid?: string;
}

export interface OutgoingMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutgoingAttachment[];
}

const toNodemailer = (list: EmailAddress[] | undefined) =>
  list?.map((a) => ({ name: a.name ?? '', address: a.email }));

/** Build the complete RFC 5322 message (what Gmail's messages.send takes as `raw`). */
export async function buildMime(message: OutgoingMessage): Promise<string> {
  const composer = new MailComposer({
    from: toNodemailer([message.from])![0],
    to: toNodemailer(message.to),
    cc: toNodemailer(message.cc),
    bcc: toNodemailer(message.bcc),
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    attachments: message.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      ...(a.cid && { cid: a.cid }),
    })),
    // Content may come from an agent: never let it make us read local files or fetch URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const node = composer.compile();
  // Bcc is dropped from the output by default; Gmail reads it from `raw` to deliver (then strips it).
  node.keepBcc = true;
  return (await node.build()).toString('utf8');
}

const sameAddress = (a: EmailAddress, b: string) => a.email.toLowerCase() === b.toLowerCase();

function dedupe(list: EmailAddress[], exclude: EmailAddress[] = []): EmailAddress[] {
  const seen = new Set(exclude.map((a) => a.email.toLowerCase()));
  return list.filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Who a reply goes to, like Gmail: Reply-To (else From); reply-all adds the other recipients. */
export function replyRecipients(
  original: Message,
  self: string,
  replyAll: boolean,
): { to: EmailAddress[]; cc: EmailAddress[] } {
  const fromSelf = original.from !== undefined && sameAddress(original.from, self);
  // Replying to our own message continues the conversation with its recipients.
  const primary = fromSelf
    ? original.to
    : original.replyTo.length > 0
      ? original.replyTo
      : original.from
        ? [original.from]
        : [];
  const notSelf = (a: EmailAddress) => !sameAddress(a, self);
  if (!replyAll) return { to: dedupe(primary), cc: [] };
  const to = dedupe([...primary, ...original.to].filter(notSelf));
  return { to: to.length > 0 ? to : dedupe(primary), cc: dedupe(original.cc.filter(notSelf), to) };
}

export const replySubject = (subject: string) =>
  /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
export const forwardSubject = (subject: string) =>
  /^(fwd?|fw):/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;

/** References header for a reply: the original's chain plus its own Message-ID. */
export function replyReferences(original: Message): string | undefined {
  const chain = [original.references, original.messageIdHeader].filter(Boolean).join(' ');
  return chain || undefined;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const textToHtml = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

function formatAddress(a: EmailAddress | undefined): string {
  if (!a) return '';
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function originalText(original: Message): string {
  if (original.bodyText) return original.bodyText;
  return (original.bodyHtml ?? original.snippet)
    .replace(/<(br|\/p|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

const originalHtml = (original: Message) => original.bodyHtml ?? textToHtml(originalText(original));

/** Reply body with the original quoted, as plain text and HTML. */
export function quoteForReply(original: Message, body: { text: string; html?: string }) {
  const attribution = `On ${original.internalDate.toUTCString()}, ${formatAddress(original.from)} wrote:`;
  const quoted = originalText(original)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  return {
    text: `${body.text}\n\n${attribution}\n${quoted}\n`,
    html:
      `${body.html ?? textToHtml(body.text)}<br><br><div class="gmail_quote">` +
      `<div>${escapeHtml(attribution)}</div>` +
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
      `${originalHtml(original)}</blockquote></div>`,
  };
}

/** Forward body: optional note, then the original's headers and content. */
export function forwardBody(original: Message, note: { text?: string; html?: string }) {
  const header = [
    '---------- Forwarded message ---------',
    `From: ${formatAddress(original.from)}`,
    `Date: ${original.internalDate.toUTCString()}`,
    `Subject: ${original.subject}`,
    `To: ${original.to.map(formatAddress).join(', ')}`,
    ...(original.cc.length > 0 ? [`Cc: ${original.cc.map(formatAddress).join(', ')}`] : []),
  ];
  const noteText = note.text ?? '';
  return {
    text: `${noteText}\n\n${header.join('\n')}\n\n${originalText(original)}\n`,
    html:
      `${note.html ?? textToHtml(noteText)}<br><br><div class="gmail_quote">` +
      `${header.map(escapeHtml).join('<br>')}<br><br>${originalHtml(original)}</div>`,
  };
}
