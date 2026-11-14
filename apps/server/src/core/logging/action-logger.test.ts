import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { type ActionEntry, ActionLogger } from './action-logger.js';

function setup() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => lines.push(JSON.parse(s)) });
  return { actions: new ActionLogger(logger), lines };
}

describe('ActionLogger', () => {
  it('writes the entry to the system log', async () => {
    const { actions, lines } = setup();
    const entry: ActionEntry = {
      actor: 'user',
      action: 'star',
      targetIds: ['m1'],
      status: 'success',
    };
    await actions.log(entry);
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'action',
        actor: 'user',
        action: 'star',
        targetIds: ['m1'],
        level: 30, // info
        msg: 'user star success',
      }),
    ]);
  });

  it('track() logs success with duration and returns the result', async () => {
    const { actions, lines } = setup();
    const result = await actions.track(
      { actor: 'agent:s1', action: 'archive', targetIds: ['m1'] },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(lines).toEqual([
      expect.objectContaining({
        actor: 'agent:s1',
        action: 'archive',
        status: 'success',
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('track() logs the error at warn and rethrows it', async () => {
    const { actions, lines } = setup();
    await expect(
      actions.track({ actor: 'user', action: 'send_email' }, async () => {
        throw new Error('quota exceeded');
      }),
    ).rejects.toThrow('quota exceeded');
    expect(lines).toEqual([
      expect.objectContaining({ status: 'error', error: 'quota exceeded', level: 40 }),
    ]);
  });
});
