import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ActionLogRepository, NewActionLog } from '../db/repositories.js';
import { ActionLogger } from './action-logger.js';

function setup(
  insert: ActionLogRepository['insert'] = async (e) => ({
    id: '1',
    ts: new Date(),
    targetIds: [],
    ...e,
  }),
) {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => lines.push(JSON.parse(s)) });
  const repo = { insert: vi.fn(insert), query: vi.fn() };
  return { actions: new ActionLogger(repo, logger), repo, lines };
}

describe('ActionLogger', () => {
  it('writes the entry to the repository and the system log', async () => {
    const { actions, repo, lines } = setup();
    const entry: NewActionLog = {
      actor: 'user',
      action: 'star',
      targetIds: ['m1'],
      status: 'success',
    };
    await actions.log(entry);
    expect(repo.insert).toHaveBeenCalledWith(entry);
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'action',
        actor: 'user',
        action: 'star',
        msg: 'user star success',
      }),
    ]);
  });

  it('track() logs success with duration and returns the result', async () => {
    const { actions, repo } = setup();
    const result = await actions.track(
      { actor: 'agent:s1', action: 'archive', targetIds: ['m1'] },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'agent:s1',
        action: 'archive',
        status: 'success',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('track() logs the error and rethrows it', async () => {
    const { actions, repo, lines } = setup();
    await expect(
      actions.track({ actor: 'user', action: 'send_email' }, async () => {
        throw new Error('quota exceeded');
      }),
    ).rejects.toThrow('quota exceeded');
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'quota exceeded' }),
    );
    expect(lines[0]).toMatchObject({ level: 40 }); // warn
  });

  it('never throws when persisting fails', async () => {
    const { actions, lines } = setup(async () => {
      throw new Error('db down');
    });
    await expect(
      actions.log({ actor: 'sync', action: 'x', status: 'success' }),
    ).resolves.toBeUndefined();
    expect(lines.at(-1)).toMatchObject({ level: 50, msg: 'failed to persist action log' });
  });
});
