import { describe, expect, it } from 'vitest';
import type { Message } from '../domain/types.js';
import { cleanBody, contentHash, emailChunk, htmlToText, MAX_BODY_CHARS } from './chunk.js';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  threadId: 't1',
  from: { name: 'Alice', email: 'alice@example.com' },
  to: [{ email: 'me@example.com' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Trip plans',
  snippet: 'snip',
  internalDate: new Date('2026-03-04T10:00:00Z'),
  hasAttachments: false,
  labelIds: ['INBOX', 'UNREAD'],
  isRead: false,
  isStarred: false,
  inInbox: true,
  attachments: [],
  ...over,
});

describe('htmlToText', () => {
  it('keeps text and structure, drops markup, styles and scripts', () => {
    expect(
      htmlToText(
        '<html><head><style>p{}</style></head><body><p>Hi&nbsp;there</p><ul><li>one</li><li>two</li></ul><script>x()</script>Bye<br>now</body></html>',
      ),
    ).toBe('Hi there\n• one\n• two\nBye\nnow');
  });
});

describe('cleanBody', () => {
  it('cuts quoted replies, signatures and > lines', () => {
    expect(
      cleanBody(
        'Sounds good!\n\nOn Mon, Mar 2, 2026 at 9:00 AM Bob <b@x.com> wrote:\n> earlier\n> text',
      ),
    ).toBe('Sounds good!');
    expect(cleanBody('收到\n\n在 2026年3月2日 写道：\n> 之前的内容')).toBe('收到');
    expect(cleanBody('Thanks\n-- \nAlice\nCEO')).toBe('Thanks');
    expect(cleanBody('See below\n\n-----Original Message-----\nFrom: x')).toBe('See below');
    expect(cleanBody('Reply text\n\nFrom: Bob <b@x.com>\nSent: Monday\nTo: me\nold')).toBe(
      'Reply text',
    );
    expect(cleanBody('a\n> quoted\nb\n\n\n\nc   d')).toBe('a\nb\n\nc d');
  });
});

describe('emailChunk', () => {
  it('combines retrieval headers and the cleaned body, without labels', () => {
    const chunk = emailChunk(
      msg({
        bodyText: 'Let us book the flight.\n\nOn Sun, Bob wrote:\n> old',
        cc: [{ name: 'Carol', email: 'c@x.com' }],
        attachments: [
          { partId: '1', filename: 'itinerary.pdf', mimeType: 'application/pdf', size: 1 },
        ],
      }),
    );
    expect(chunk).toBe(
      'Subject: Trip plans\nFrom: Alice <alice@example.com>\nTo: me@example.com\nCc: Carol <c@x.com>\nDate: 2026-03-04\nAttachments: itinerary.pdf\n\nLet us book the flight.',
    );
    expect(chunk).not.toContain('UNREAD');
  });

  it('falls back to HTML, then the snippet, and caps the body', () => {
    expect(emailChunk(msg({ bodyHtml: '<p>From <b>HTML</b></p>' }))).toContain('\n\nFrom HTML');
    expect(emailChunk(msg())).toMatch(/\n\nsnip$/);
    const long = emailChunk(msg({ bodyText: 'x'.repeat(MAX_BODY_CHARS * 2) }));
    expect(long.length).toBeLessThan(MAX_BODY_CHARS + 200);
  });

  it('hashes per model and content', () => {
    expect(contentHash('a', 'text')).toBe(contentHash('a', 'text'));
    expect(contentHash('a', 'text')).not.toBe(contentHash('b', 'text'));
  });
});
