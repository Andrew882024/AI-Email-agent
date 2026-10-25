import { describe, expect, it } from 'vitest';
import { applyToMessage, applyToThread, belongsInList, labelChangeFor } from '../state/optimistic';
import type { Message, ThreadSummary } from '../api/mail';
import { buildEmailDocument, textToHtml } from './email-html';
import { participantsLine, shortDate, splitRecipients } from './format';

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: 't',
  subject: 's',
  snippet: '',
  lastMessageAt: '2026-01-01T00:00:00Z',
  messageCount: 2,
  participants: [],
  labelIds: ['INBOX', 'UNREAD'],
  isRead: false,
  isStarred: false,
  inInbox: true,
  hasAttachments: false,
  messageIds: ['m1', 'm2'],
  ...over,
});

describe('optimistic label changes', () => {
  it('maps tools to label changes', () => {
    expect(labelChangeFor('archive', { messageIds: ['m1'] })).toEqual({
      messageIds: ['m1'],
      add: [],
      remove: ['INBOX'],
    });
    expect(labelChangeFor('add_label', { messageIds: ['m1'], label: 'Label_1' })).toEqual({
      messageIds: ['m1'],
      add: ['Label_1'],
      remove: [],
    });
    expect(labelChangeFor('send_email', {})).toBeUndefined();
  });

  it('updates threads and messages and recomputes flags', () => {
    const change = { messageIds: ['m1', 'm2'], add: ['STARRED'], remove: ['UNREAD'] };
    expect(applyToThread(thread(), change)).toMatchObject({
      labelIds: ['INBOX', 'STARRED'],
      isRead: true,
      isStarred: true,
    });
    expect(applyToThread(thread({ messageIds: ['x'] }), change).isStarred).toBe(false);
    const message = {
      id: 'm1',
      labelIds: ['INBOX'],
      isRead: true,
      isStarred: false,
      inInbox: true,
    } as Message;
    expect(
      applyToMessage(message, { messageIds: ['m1'], add: [], remove: ['INBOX'] }),
    ).toMatchObject({ labelIds: [], inInbox: false });
  });

  it('knows when a thread leaves the current list', () => {
    const archived = applyToThread(thread(), { messageIds: ['m1'], add: [], remove: ['INBOX'] });
    expect(belongsInList(archived, 'inbox')).toBe(false);
    expect(belongsInList(archived, 'archived')).toBe(true);
    expect(belongsInList(thread(), 'all', 'Label_1')).toBe(false);
  });
});

describe('formatting', () => {
  it('lists participants like Gmail', () => {
    const people = [
      { name: 'Alice Smith', email: 'a@x.com' },
      { email: 'me@x.com' },
      { email: 'bob@y.com' },
      { email: 'c@z.com' },
    ];
    expect(participantsLine(people, 'ME@x.com')).toBe('Alice Smith, me, bob …');
  });

  it('formats dates relative to now', () => {
    const now = new Date('2026-10-19T15:00:00');
    expect(shortDate('2026-10-19T09:05:00', now)).toBe('9:05 AM');
    expect(shortDate('2026-03-04T09:05:00', now)).toBe('Mar 4');
    expect(shortDate('2025-03-04T09:05:00', now)).toBe('3/4/25');
  });

  it('splits recipient lists without breaking quoted names', () => {
    expect(splitRecipients('a@x.com, "Doe, Jane" <j@x.com>; b@y.com,')).toEqual([
      'a@x.com',
      '"Doe, Jane" <j@x.com>',
      'b@y.com',
    ]);
  });
});

describe('email document', () => {
  const options = {
    origin: 'http://127.0.0.1:4317',
    cidUrl: (cid: string) => (cid === 'logo@x' ? '/api/messages/m1/attachments/2' : undefined),
  };

  it('blocks scripts, allows remote images and rewrites inline images', () => {
    const doc = buildEmailDocument(
      {
        html: '<img src="cid:logo@x"><img src="https://track.example/p.gif"><script>alert(1)</script>',
      },
      options,
    );
    expect(doc).toContain('src="/api/messages/m1/attachments/2"');
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain('img-src data: http://127.0.0.1:4317 https: http:');
  });

  it('renders plain text safely with links', () => {
    expect(textToHtml('<b> see https://x.com/a?b=1')).toBe(
      '&#60;b&#62; see <a href="https://x.com/a?b=1">https://x.com/a?b=1</a>',
    );
    expect(buildEmailDocument({ text: 'hi' }, options)).toContain(
      '<div style="white-space:pre-wrap">hi</div>',
    );
  });
});
