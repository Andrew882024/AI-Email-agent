import { describe, expect, it } from 'vitest';
import type { Message } from '../domain/types.js';
import {
  buildMime,
  forwardBody,
  forwardSubject,
  quoteForReply,
  replyRecipients,
  replyReferences,
  replySubject,
} from './compose.js';

const original = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  threadId: 't1',
  from: { name: 'Alice', email: 'alice@example.com' },
  to: [{ email: 'me@example.com' }, { email: 'bob@example.com' }],
  cc: [{ email: 'carol@example.com' }, { email: 'ME@example.com' }],
  bcc: [],
  replyTo: [],
  subject: 'Plans',
  snippet: '',
  bodyText: 'line one\nline two',
  internalDate: new Date('2026-03-01T10:00:00Z'),
  hasAttachments: false,
  labelIds: [],
  isRead: true,
  isStarred: false,
  inInbox: true,
  attachments: [],
  messageIdHeader: '<orig@mail>',
  references: '<root@mail>',
  ...over,
});

describe('reply addressing', () => {
  it('replies to the sender, or Reply-To when set', () => {
    expect(replyRecipients(original(), 'me@example.com', false)).toEqual({
      to: [{ name: 'Alice', email: 'alice@example.com' }],
      cc: [],
    });
    const viaList = original({ replyTo: [{ email: 'list@example.com' }] });
    expect(replyRecipients(viaList, 'me@example.com', false).to).toEqual([
      { email: 'list@example.com' },
    ]);
  });

  it('reply-all adds everyone except me, without duplicates', () => {
    expect(replyRecipients(original(), 'me@example.com', true)).toEqual({
      to: [{ name: 'Alice', email: 'alice@example.com' }, { email: 'bob@example.com' }],
      cc: [{ email: 'carol@example.com' }],
    });
  });

  it('replying to my own message goes to its recipients', () => {
    const mine = original({
      from: { email: 'me@example.com' },
      to: [{ email: 'bob@example.com' }],
    });
    expect(replyRecipients(mine, 'me@example.com', false).to).toEqual([
      { email: 'bob@example.com' },
    ]);
  });

  it('builds subjects and references', () => {
    expect(replySubject('Plans')).toBe('Re: Plans');
    expect(replySubject('RE: Plans')).toBe('RE: Plans');
    expect(forwardSubject('Plans')).toBe('Fwd: Plans');
    expect(forwardSubject('Fw: Plans')).toBe('Fw: Plans');
    expect(replyReferences(original())).toBe('<root@mail> <orig@mail>');
    expect(
      replyReferences(original({ references: undefined, messageIdHeader: undefined })),
    ).toBeUndefined();
  });
});

describe('bodies', () => {
  it('quotes the original in text and HTML, escaping the new text', () => {
    const body = quoteForReply(original(), { text: 'Sounds <good>' });
    expect(body.text).toBe(
      'Sounds <good>\n\nOn Sun, 01 Mar 2026 10:00:00 GMT, Alice <alice@example.com> wrote:\n> line one\n> line two\n',
    );
    expect(body.html).toContain('Sounds &#60;good&#62;');
    expect(body.html).toContain('<blockquote class="gmail_quote"');
    expect(body.html).toContain('line one<br>line two');
  });

  it('forwards with the original headers', () => {
    const body = forwardBody(original(), { text: 'FYI' });
    expect(body.text).toContain(
      'FYI\n\n---------- Forwarded message ---------\nFrom: Alice <alice@example.com>',
    );
    expect(body.text).toContain('Cc: carol@example.com, ME@example.com');
    expect(body.text).toContain('Subject: Plans');
  });
});

describe('buildMime', () => {
  it('produces a threaded message with Bcc kept and attachments encoded', async () => {
    const raw = await buildMime({
      from: { name: 'Me', email: 'me@example.com' },
      to: [{ name: 'Ann Lee', email: 'ann@example.com' }],
      bcc: [{ email: 'hidden@example.com' }],
      subject: 'Re: 你好',
      text: 'body',
      html: '<p>body</p>',
      inReplyTo: '<orig@mail>',
      references: '<root@mail> <orig@mail>',
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('file!') },
      ],
    });
    expect(raw).toMatch(/^From: Me <me@example\.com>$/m);
    expect(raw).toMatch(/^To: Ann Lee <ann@example\.com>$/m);
    expect(raw).toMatch(/^Bcc: hidden@example\.com$/m);
    const subject = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(raw)?.[1];
    expect(Buffer.from(subject!, 'base64').toString()).toBe('Re: 你好');
    expect(raw).toMatch(/^In-Reply-To: <orig@mail>$/m);
    expect(raw).toMatch(/^References: <root@mail> <orig@mail>$/m);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('filename=a.txt');
    expect(raw).toContain(Buffer.from('file!').toString('base64'));
  });

  it('never reads local files referenced by attachment input', async () => {
    const raw = await buildMime({
      from: { email: 'me@example.com' },
      to: [{ email: 'x@example.com' }],
      subject: 's',
      text: 't',
      attachments: [{ filename: 'p', contentType: 'text/plain', path: '/etc/hosts' } as never],
    });
    expect(raw).not.toContain(Buffer.from('localhost').toString('base64').slice(0, 8));
    expect(raw).not.toContain('localhost');
  });
});
