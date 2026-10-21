import { describe, expect, it } from 'vitest';
import { AuthFlowError } from './errors.js';
import { startLoopbackReceiver } from './loopback.js';

const callback = (redirectUri: string, params: Record<string, string>) =>
  fetch(`${redirectUri}?${new URLSearchParams(params)}`);

describe('startLoopbackReceiver', () => {
  it('listens on 127.0.0.1 and resolves the code for the matching state', async () => {
    const receiver = await startLoopbackReceiver('s1');
    try {
      expect(receiver.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
      const pending = receiver.waitForCode({ timeoutMs: 5000 });
      const res = await callback(receiver.redirectUri, { state: 's1', code: 'abc' });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Signed in');
      await expect(pending).resolves.toBe('abc');
    } finally {
      await receiver.close();
    }
  });

  it('ignores requests with a wrong state and keeps waiting', async () => {
    const receiver = await startLoopbackReceiver('s1');
    try {
      const pending = receiver.waitForCode({ timeoutMs: 5000 });
      expect((await callback(receiver.redirectUri, { state: 'forged', code: 'evil' })).status).toBe(
        400,
      );
      expect((await fetch(receiver.redirectUri.replace('/oauth2callback', '/other'))).status).toBe(
        404,
      );
      await callback(receiver.redirectUri, { state: 's1', code: 'good' });
      await expect(pending).resolves.toBe('good');
    } finally {
      await receiver.close();
    }
  });

  it('rejects when the user denies consent', async () => {
    const receiver = await startLoopbackReceiver('s1');
    try {
      const outcome = receiver.waitForCode({ timeoutMs: 5000 }).catch((err: unknown) => err);
      await callback(receiver.redirectUri, { state: 's1', error: 'access_denied' });
      const err = await outcome;
      expect(err).toBeInstanceOf(AuthFlowError);
      expect((err as Error).message).toContain('access_denied');
    } finally {
      await receiver.close();
    }
  });

  it('rejects on timeout and on abort', async () => {
    const receiver = await startLoopbackReceiver('s1');
    try {
      await expect(receiver.waitForCode({ timeoutMs: 20 })).rejects.toThrow('timed out');
      const controller = new AbortController();
      const pending = receiver.waitForCode({ timeoutMs: 5000, signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
    } finally {
      await receiver.close();
    }
  });
});
