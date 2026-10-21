import { describe, expect, it } from 'vitest';
import { baseFor, formatHash, parseHash, routeFor } from './routes';

const labels = [
  { id: 'Label_7', name: 'Internship Applications' },
  { id: 'Label_9', name: 'Work/Projects' },
  { id: 'IMPORTANT', name: 'IMPORTANT' },
];

describe('hash routes', () => {
  it('parses views, pages and threads, and normalizes anything else to the inbox', () => {
    expect(parseHash('')).toEqual({ base: 'inbox', page: 1 });
    expect(parseHash('#starred')).toEqual({ base: 'starred', page: 1 });
    expect(parseHash('#inbox/p3')).toEqual({ base: 'inbox', page: 3 });
    expect(parseHash('#inbox/19a2b3c4d5e6f7a8')).toEqual({
      base: 'inbox',
      page: 1,
      threadId: '19a2b3c4d5e6f7a8',
    });
    expect(parseHash('#all/p2/abc123')).toEqual({ base: 'all', page: 2, threadId: 'abc123' });
    expect(parseHash('#todos/abc123')).toEqual({ base: 'todos', page: 1, threadId: 'abc123' });
    expect(parseHash('#inbox/p0')).toEqual({ base: 'inbox', page: 1 });
    expect(parseHash('#nonsense/x')).toEqual({ base: 'inbox', page: 1 });
    expect(parseHash('#label')).toEqual({ base: 'inbox', page: 1 });
  });

  it('encodes labels and searches like Gmail and round-trips them', () => {
    const label = {
      kind: 'mail',
      view: 'all',
      label: 'Label_7',
      labelName: 'Internship Applications',
    } as const;
    expect(baseFor(label)).toBe('label/Internship+Applications');
    expect(
      baseFor({ kind: 'mail', view: 'all', label: 'Label_9', labelName: 'Work/Projects' }),
    ).toBe('label/Work%2FProjects');
    expect(baseFor({ kind: 'mail', view: 'all', query: '实习 offer' })).toBe(
      'search/%E5%AE%9E%E4%B9%A0+offer',
    );
    expect(baseFor({ kind: 'todos' })).toBe('todos');
    expect(baseFor({ kind: 'mail', view: 'archived' })).toBe('archived');

    const hash = formatHash({ base: baseFor(label), page: 2, threadId: 't1' });
    expect(hash).toBe('#label/Internship+Applications/p2/t1');
    const parsed = parseHash(hash);
    expect(parsed).toEqual({ base: 'label/Internship+Applications', page: 2, threadId: 't1' });
    expect(routeFor(parsed.base, labels)).toEqual(label);
    expect(routeFor('search/%E5%AE%9E%E4%B9%A0+offer', labels)).toEqual({
      kind: 'mail',
      view: 'all',
      query: '实习 offer',
    });
    // Hand-typed: spaces, any case.
    expect(parseHash('#label/internship%20applications').base).toBe(
      'label/internship+applications',
    );
  });

  it('resolves label names once labels load, by name then id', () => {
    expect(routeFor('label/Internship+Applications', undefined)).toBe('loading');
    expect(routeFor('label/internship+applications', labels)).toMatchObject({ label: 'Label_7' });
    expect(routeFor('label/Work%2FProjects', labels)).toMatchObject({ label: 'Label_9' });
    expect(routeFor('label/important', labels)).toMatchObject({ label: 'IMPORTANT' });
    expect(routeFor('label/Nope', labels)).toBeUndefined();
    expect(routeFor('inbox', undefined)).toEqual({ kind: 'mail', view: 'inbox' });
    expect(routeFor('todos', undefined)).toEqual({ kind: 'todos' });
  });
});
