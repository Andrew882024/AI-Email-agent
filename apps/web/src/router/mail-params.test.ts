import { describe, expect, it } from 'vitest';
import { formatMailHash, type MailParams, parseMailHash, sameList } from './mail-params';

describe('mail page parameters', () => {
  it('parses lists, pages and conversations; anything else is the inbox', () => {
    expect(parseMailHash('')).toEqual({ list: { kind: 'view', view: 'inbox' }, page: 1 });
    expect(parseMailHash('#starred')).toEqual({ list: { kind: 'view', view: 'starred' }, page: 1 });
    expect(parseMailHash('#inbox/p4/1a1374688843c397')).toEqual({
      list: { kind: 'view', view: 'inbox' },
      page: 4,
      threadId: '1a1374688843c397',
    });
    expect(parseMailHash('#all/abc123')).toEqual({
      list: { kind: 'view', view: 'all' },
      page: 1,
      threadId: 'abc123',
    });
    expect(parseMailHash('#todos/abc123')).toEqual({
      list: { kind: 'todos' },
      page: 1,
      threadId: 'abc123',
    });
    expect(parseMailHash('#inbox/p0').page).toBe(1);
    expect(parseMailHash('#nonsense/x')).toEqual({
      list: { kind: 'view', view: 'inbox' },
      page: 1,
    });
    expect(parseMailHash('#label')).toEqual({ list: { kind: 'view', view: 'inbox' }, page: 1 });
  });

  it('encodes labels and searches like Gmail and round-trips them', () => {
    const cases: [MailParams, string][] = [
      [
        { list: { kind: 'label', name: 'Internship Applications' }, page: 2, threadId: 't1' },
        '#label/Internship+Applications/p2/t1',
      ],
      [{ list: { kind: 'label', name: 'Work/Projects' }, page: 1 }, '#label/Work%2FProjects'],
      [
        { list: { kind: 'search', query: '实习 offer' }, page: 1 },
        '#search/%E5%AE%9E%E4%B9%A0+offer',
      ],
      [{ list: { kind: 'view', view: 'archived' }, page: 3 }, '#archived/p3'],
      [{ list: { kind: 'todos' }, page: 1 }, '#todos'],
    ];
    for (const [params, hash] of cases) {
      expect(formatMailHash(params)).toBe(hash);
      expect(parseMailHash(hash)).toEqual(params);
    }
    // Hand-typed spaces work too, and the canonical form uses "+".
    expect(formatMailHash(parseMailHash('#label/internship%20applications'))).toBe(
      '#label/internship+applications',
    );
  });

  it('compares lists, label names case-insensitively', () => {
    expect(sameList({ kind: 'label', name: 'Bills' }, { kind: 'label', name: 'bills' })).toBe(true);
    expect(sameList({ kind: 'view', view: 'inbox' }, { kind: 'view', view: 'inbox' })).toBe(true);
    expect(sameList({ kind: 'view', view: 'all' }, { kind: 'search', query: 'all' })).toBe(false);
    expect(sameList({ kind: 'todos' }, { kind: 'todos' })).toBe(true);
  });
});
