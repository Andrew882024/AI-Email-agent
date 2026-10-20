import { describe, expect, it } from 'vitest';
import type { GmailMessage } from '../google/gateways.js';
import {
  decodeEntities,
  parseAddresses,
  parseGmailLabel,
  parseGmailMessage,
} from './parse-message.js';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const h = (name: string, value: string) => ({ name, value });

describe('parseGmailMessage', () => {
  it('parses headers, alternative bodies, attachments and inline images', () => {
    const message: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      historyId: '900',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'Hi &amp; welcome &#39;Bob&#39;',
      internalDate: '1767225600000',
      sizeEstimate: 1234,
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          h('From', '"Doe, Jane" <jane@example.com>'),
          h('To', 'bob@example.com, Team: a@x.com, b@x.com;'),
          h('Cc', ''),
          h('Subject', 'Quarterly report'),
          h('Message-ID', '<abc@mail.example.com>'),
          h('In-Reply-To', '<prev@mail>'),
          h('References', '<root@mail> <prev@mail>'),
        ],
        parts: [
          {
            mimeType: 'multipart/related',
            parts: [
              {
                mimeType: 'multipart/alternative',
                parts: [
                  {
                    partId: '0.0.0',
                    mimeType: 'text/plain',
                    headers: [h('Content-Type', 'text/plain; charset="UTF-8"')],
                    body: { data: b64('plain body') },
                  },
                  {
                    partId: '0.0.1',
                    mimeType: 'text/html',
                    body: { data: b64('<p>html body</p>') },
                  },
                ],
              },
              {
                partId: '0.1',
                mimeType: 'image/png',
                filename: 'logo.png',
                headers: [
                  h('Content-ID', '<logo@x>'),
                  h('Content-Disposition', 'inline; filename=logo.png'),
                ],
                body: { attachmentId: 'att-logo', size: 100 },
              },
            ],
          },
          {
            partId: '1',
            mimeType: 'application/pdf',
            filename: 'report.pdf',
            headers: [h('Content-Disposition', 'attachment; filename="report.pdf"')],
            body: { attachmentId: 'att-pdf', size: 5000 },
          },
        ],
      },
    };

    expect(parseGmailMessage(message)).toEqual({
      id: 'm1',
      threadId: 't1',
      historyId: '900',
      messageIdHeader: '<abc@mail.example.com>',
      inReplyTo: '<prev@mail>',
      references: '<root@mail> <prev@mail>',
      from: { name: 'Doe, Jane', email: 'jane@example.com' },
      to: [{ email: 'bob@example.com' }, { email: 'a@x.com' }, { email: 'b@x.com' }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Quarterly report',
      snippet: "Hi & welcome 'Bob'",
      bodyText: 'plain body',
      bodyHtml: '<p>html body</p>',
      internalDate: new Date(1767225600000),
      sizeEstimate: 1234,
      hasAttachments: true,
      labelIds: ['INBOX', 'UNREAD'],
      attachments: [
        {
          partId: '0.1',
          attachmentId: 'att-logo',
          filename: 'logo.png',
          mimeType: 'image/png',
          size: 100,
          contentId: 'logo@x',
        },
        {
          partId: '1',
          attachmentId: 'att-pdf',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          size: 5000,
        },
      ],
    });
  });

  it('decodes non-UTF-8 charsets', () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // "你好" in GBK
    const parsed = parseGmailMessage({
      id: 'm2',
      threadId: 't2',
      internalDate: '0',
      payload: {
        mimeType: 'text/plain',
        headers: [h('Content-Type', 'text/plain; charset=gb2312'), h('Subject', '问候')],
        body: { data: b64(gbk) },
      },
    });
    expect(parsed.bodyText).toBe('你好');
    expect(parsed.subject).toBe('问候');
  });

  it('treats a message with only inline images as having no attachments', () => {
    const parsed = parseGmailMessage({
      id: 'm3',
      threadId: 't3',
      internalDate: '0',
      payload: {
        mimeType: 'multipart/related',
        parts: [
          { partId: '0', mimeType: 'text/html', body: { data: b64('<img src="cid:x">') } },
          {
            partId: '1',
            mimeType: 'image/gif',
            filename: 'x.gif',
            headers: [h('Content-ID', '<x>')],
            body: { attachmentId: 'a', size: 1 },
          },
        ],
      },
    });
    expect(parsed.hasAttachments).toBe(false);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.bodyText).toBeUndefined();
  });

  it('rejects messages without ids', () => {
    expect(() => parseGmailMessage({ id: 'x' })).toThrow('without id');
  });
});

describe('helpers', () => {
  it('parses address lists', () => {
    expect(parseAddresses('Alice <a@x.com>, b@y.com')).toEqual([
      { name: 'Alice', email: 'a@x.com' },
      { email: 'b@y.com' },
    ]);
    expect(parseAddresses(undefined)).toEqual([]);
    expect(parseAddresses('undisclosed-recipients:;')).toEqual([]);
  });

  it('decodes HTML entities', () => {
    expect(decodeEntities('a &lt;b&gt; &#x4F60;&#22909; &unknown;')).toBe('a <b> 你好 &unknown;');
  });

  it('maps labels', () => {
    expect(parseGmailLabel({ id: 'INBOX', name: 'INBOX', type: 'system' })).toEqual({
      id: 'INBOX',
      name: 'INBOX',
      type: 'system',
    });
    expect(
      parseGmailLabel({
        id: 'Label_1',
        name: 'Bills',
        type: 'user',
        color: { backgroundColor: '#fff', textColor: '#000' },
      }),
    ).toEqual({
      id: 'Label_1',
      name: 'Bills',
      type: 'user',
      color: { background: '#fff', text: '#000' },
    });
    expect(parseGmailLabel({ id: 'x' })).toBeUndefined();
  });
});
