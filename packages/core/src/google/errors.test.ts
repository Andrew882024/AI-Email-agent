import { describe, expect, it } from 'vitest';
import { ReauthRequiredError } from '../auth/errors.js';
import {
  httpStatus,
  isNetworkError,
  isRateLimitError,
  isRetryableGoogleError,
  retryAfterMs,
} from './errors.js';
import { mapLimit, QuotaLimiter, withRetry } from './retry.js';

const status = (code: number, reason?: string) =>
  Object.assign(new Error(`HTTP ${code}`), {
    response: { status: code, data: { error: { errors: reason ? [{ reason }] : [] } } },
  });

describe('Google error classification', () => {
  it('retries rate limits, 5xx and network failures only', () => {
    expect(isRetryableGoogleError(status(429))).toBe(true);
    expect(isRetryableGoogleError(status(503))).toBe(true);
    expect(isRetryableGoogleError(status(403, 'userRateLimitExceeded'))).toBe(true);
    expect(isRetryableGoogleError(status(403, 'insufficientPermissions'))).toBe(false);
    expect(isRetryableGoogleError(status(400))).toBe(false);
    expect(isRetryableGoogleError(status(404))).toBe(false);

    const offline = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
    });
    expect(isNetworkError(offline)).toBe(true);
    expect(isRetryableGoogleError(Object.assign(new Error('x'), { name: 'GaxiosError' }))).toBe(
      true,
    );

    // Not network problems: must not be retried.
    expect(isRetryableGoogleError(new ReauthRequiredError('a', 'expired'))).toBe(false);
    expect(isRetryableGoogleError(new TypeError('Cannot read properties of undefined'))).toBe(
      false,
    );
    expect(httpStatus(status(418))).toBe(418);
  });
});

describe('withRetry', () => {
  it('retries transient failures with backoff, then gives up', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => void delays.push(ms);
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          if (calls < 3) throw status(503);
          return 'ok';
        },
        { sleep },
      ),
    ).resolves.toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    expect(Math.max(...delays)).toBeLessThan(1500);

    calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw status(400);
        },
        { sleep },
      ),
    ).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('waits long enough on quota errors to cross a per-minute window', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => void delays.push(ms);
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw status(429);
        },
        { sleep },
      ),
    ).rejects.toThrow('HTTP 429');
    expect(calls).toBe(6);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(31_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
  });

  it('honors Retry-After', async () => {
    const delays: number[] = [];
    const err = Object.assign(status(429), {});
    (err.response as Record<string, unknown>).headers = new Headers({ 'retry-after': '30' });
    expect(retryAfterMs(err)).toBe(30_000);
    expect(isRateLimitError(err)).toBe(true);
    let calls = 0;
    await withRetry(
      async () => {
        if (calls++ === 0) throw err;
        return 'ok';
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays[0]).toBeGreaterThanOrEqual(30_000);
  });
});

describe('QuotaLimiter', () => {
  it('lets one second of burst through, then paces callers to the rate, in order', async () => {
    let now = 0;
    const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
    const limiter = new QuotaLimiter(100, clock);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => limiter.take(5).then(() => order.push(i))),
    );
    // 40 calls x 5 units = 200 units at 100/s with a 100-unit burst → ~1s of waiting.
    expect(now).toBeGreaterThanOrEqual(1000);
    expect(now).toBeLessThan(1100);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('derives a per-second budget from a per-minute quota with headroom', () => {
    expect(QuotaLimiter.perMinute(600).unitsPerSecond).toBe(8); // 80% of 600/min
  });

  it('halves its pace on quota rejections (once per burst) and recovers on success', () => {
    let now = 0;
    const limiter = new QuotaLimiter(100, { now: () => now, sleep: async () => {} });
    for (let i = 0; i < 10; i++) limiter.backoff(); // ten parallel rejections = one signal
    expect(limiter.unitsPerSecond).toBe(50);
    now += 1000;
    limiter.backoff();
    expect(limiter.unitsPerSecond).toBe(25);
    for (let i = 0; i < 20; i++) {
      now += 1000;
      limiter.backoff();
    }
    expect(limiter.unitsPerSecond).toBeCloseTo(100 / 64);
    for (let i = 0; i < 1000; i++) limiter.recover();
    expect(limiter.unitsPerSecond).toBe(100);
  });
});

describe('mapLimit', () => {
  it('keeps order and caps concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5 - (n % 3)));
      inFlight--;
      return n * 10;
    });
    expect(result).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});
