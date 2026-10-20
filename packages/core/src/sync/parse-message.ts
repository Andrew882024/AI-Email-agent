import addressparser from 'addressparser';
import type { gmail_v1 } from '@googleapis/gmail';
import type { Attachment, EmailAddress, Label, MessageUpsert } from '../domain/types.js';
import type { GmailLabel, GmailMessage } from '../google/gateways.js';

type Part = gmail_v1.Schema$MessagePart;

function headerMap(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of headers ?? []) {
    const name = h.name?.toLowerCase();
    if (name && !map.has(name)) map.set(name, h.value ?? '');
  }
  return map;
}

export function parseAddresses(value: string | undefined): EmailAddress[] {
  if (!value?.trim()) return [];
  const flat = addressparser(value).flatMap((a) => ('group' in a && a.group ? a.group : [a]));
  return flat.flatMap((a) =>
    'address' in a && a.address ? [{ ...(a.name && { name: a.name }), email: a.address }] : [],
  );
}

function charsetOf(contentType: string | undefined): string {
  return /charset="?([^";\s]+)"?/i.exec(contentType ?? '')?.[1]?.toLowerCase() ?? 'utf-8';
}

/** Gmail returns part bodies base64url-encoded in their original charset. */
function decodeBody(data: string, charset: string): string {
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes); // unknown charset label
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Gmail snippets are HTML-escaped plain text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

interface Walked {
  text?: string;
  html?: string;
  attachments: Attachment[];
  /** Attachments shown as files (not inline images referenced from the HTML body). */
  fileCount: number;
}

function walk(part: Part, out: Walked): void {
  const headers = headerMap(part.headers);
  const mimeType = part.mimeType?.toLowerCase() ?? '';
  const disposition = headers.get('content-disposition')?.toLowerCase() ?? '';
  const isAttachment =
    !!part.filename ||
    disposition.startsWith('attachment') ||
    (!!part.body?.attachmentId && !mimeType.startsWith('text/'));

  if (isAttachment && part.partId !== undefined && part.partId !== null) {
    const contentId = headers.get('content-id')?.replace(/^<|>$/g, '');
    out.attachments.push({
      partId: part.partId,
      attachmentId: part.body?.attachmentId ?? undefined,
      filename: part.filename ?? '',
      mimeType: mimeType || 'application/octet-stream',
      size: part.body?.size ?? 0,
      ...(contentId && { contentId }),
    });
    if (!contentId || disposition.startsWith('attachment')) out.fileCount++;
    return;
  }
  if (part.parts?.length) {
    for (const child of part.parts) walk(child, out);
    return;
  }
  const data = part.body?.data;
  if (!data) return;
  if (mimeType === 'text/plain' && out.text === undefined) {
    out.text = decodeBody(data, charsetOf(headers.get('content-type')));
  } else if (mimeType === 'text/html' && out.html === undefined) {
    out.html = decodeBody(data, charsetOf(headers.get('content-type')));
  }
}

/** Gmail API `format=full` message → what the message repository stores. */
export function parseGmailMessage(message: GmailMessage): MessageUpsert {
  if (!message.id || !message.threadId) throw new Error('Gmail message without id/threadId');
  const payload = message.payload ?? {};
  const headers = headerMap(payload.headers);
  const walked: Walked = { attachments: [], fileCount: 0 };
  walk(payload, walked);

  return {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId ?? undefined,
    messageIdHeader: headers.get('message-id'),
    inReplyTo: headers.get('in-reply-to'),
    references: headers.get('references'),
    from: parseAddresses(headers.get('from'))[0],
    to: parseAddresses(headers.get('to')),
    cc: parseAddresses(headers.get('cc')),
    bcc: parseAddresses(headers.get('bcc')),
    replyTo: parseAddresses(headers.get('reply-to')),
    subject: headers.get('subject') ?? '',
    snippet: decodeEntities(message.snippet ?? ''),
    bodyText: walked.text,
    bodyHtml: walked.html,
    internalDate: new Date(Number(message.internalDate ?? 0)),
    sizeEstimate: message.sizeEstimate ?? undefined,
    hasAttachments: walked.fileCount > 0,
    labelIds: message.labelIds ?? [],
    attachments: walked.attachments,
  };
}

export function parseGmailLabel(label: GmailLabel): Label | undefined {
  if (!label.id || !label.name) return undefined;
  const background = label.color?.backgroundColor;
  const text = label.color?.textColor;
  return {
    id: label.id,
    name: label.name,
    type: label.type === 'user' ? 'user' : 'system',
    ...(background && text && { color: { background, text } }),
  };
}
