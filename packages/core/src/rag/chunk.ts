import { createHash } from 'node:crypto';
import type { EmailAddress, Message } from '../domain/types.js';
import { decodeEntities } from '../sync/parse-message.js';

/** Upper bound on body text per chunk; gemini-embedding-2 reads ~8k tokens and truncates beyond. */
export const MAX_BODY_CHARS = 12_000;

/** Readable text from an HTML email body. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  );
}

/**
 * The new content of a message: quoted replies, forwarded-history markers and signatures cut,
 * whitespace collapsed. Earlier messages of a thread have their own chunks, so quoting them
 * again would only dilute this one.
 */
export function cleanBody(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    // Start of quoted history: "On <date>, X wrote:", Outlook headers, "--- Original Message ---".
    if (/^On .{4,200} wrote:$/i.test(trimmed) || /^在.{2,100}写道[:：]$/.test(trimmed)) break;
    if (/^-{2,}\s*(Original Message|原始邮件)\s*-{2,}$/i.test(trimmed)) break;
    // Outlook-style quote block after a blank line: "From: … / Sent: … / To: …"
    if (
      /^From: .+/.test(trimmed) &&
      kept.includes('') &&
      /^(Sent|Date):/m.test(lines.slice(i + 1, i + 4).join('\n'))
    ) {
      break;
    }
    if (trimmed === '--') break; // RFC 3676 signature delimiter ("-- ")
    if (trimmed.startsWith('>')) continue;
    kept.push(trimmed);
  }
  return kept
    .join('\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const address = (a: EmailAddress) => (a.name ? `${a.name} <${a.email}>` : a.email);

/**
 * The one chunk that represents an email in the vector index: headers that matter for retrieval
 * plus the cleaned body. Labels are left out on purpose: they change often (read, archive, ...)
 * and are applied as search filters instead.
 */
export function emailChunk(message: Message): string {
  const body = cleanBody(
    message.bodyText ?? (message.bodyHtml ? htmlToText(message.bodyHtml) : message.snippet),
  );
  const attachments = message.attachments.filter((a) => a.filename).map((a) => a.filename);
  return [
    `Subject: ${message.subject || '(no subject)'}`,
    `From: ${message.from ? address(message.from) : 'unknown'}`,
    message.to.length ? `To: ${message.to.map(address).join(', ')}` : '',
    message.cc.length ? `Cc: ${message.cc.map(address).join(', ')}` : '',
    `Date: ${message.internalDate.toISOString().slice(0, 10)}`,
    attachments.length ? `Attachments: ${attachments.join(', ')}` : '',
    '',
    body.slice(0, MAX_BODY_CHARS),
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .trim();
}

/** Identifies chunk content + model, to skip re-embedding unchanged messages. */
export function contentHash(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('hex');
}
