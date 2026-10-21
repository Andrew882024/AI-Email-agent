import { isRateLimitError, isRetryableGoogleError, retryAfterMs } from './errors.js';

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  /** Starting backoff for quota errors; Gmail's per-user quota is enforced per minute. */
  rateLimitBaseDelayMs?: number;
  maxDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry transient Google errors with exponential backoff and jitter. Quota errors back off from
 * 2s up to 60s (enough to cross a per-minute window) and honor Retry-After.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    retries = 5,
    baseDelayMs = 500,
    rateLimitBaseDelayMs = 2000,
    maxDelayMs = 60_000,
    sleep = defaultSleep,
  } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableGoogleError(err)) throw err;
      const base = isRateLimitError(err) ? rateLimitBaseDelayMs : baseDelayMs;
      const backoff = Math.min(maxDelayMs, base * 2 ** attempt * (0.5 + Math.random()));
      await sleep(Math.max(backoff, Math.min(maxDelayMs, retryAfterMs(err) ?? 0)));
    }
  }
}

/**
 * Adaptive token bucket over Google quota units. Starts at the configured pace; when Google still
 * rejects calls for quota (real per-call costs can be far above the documented ones), it halves
 * the pace, then creeps back up on success (AIMD), settling at what the project actually allows.
 * The bucket holds at most one second of budget, since Google enforces "per minute" quotas over a
 * sliding window. Waiters are served in order.
 */
export class QuotaLimiter {
  private rate: number;
  private tokens: number;
  private last: number;
  private lastBackoff = -Infinity;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxRate: number,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: () => performance.now(),
      sleep: defaultSleep,
    },
  ) {
    this.rate = maxRate;
    this.tokens = maxRate;
    this.last = clock.now();
  }

  /** Budget for a "units per minute" quota, keeping `headroom` of it for other clients. */
  static perMinute(unitsPerMinute: number, headroom = 0.2): QuotaLimiter {
    return new QuotaLimiter((unitsPerMinute * (1 - headroom)) / 60);
  }

  /** Current pace in units per second. */
  get unitsPerSecond(): number {
    return this.rate;
  }

  take(units: number): Promise<void> {
    const turn = this.queue.then(() => this.acquire(units));
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Google rejected a call for quota: halve the pace (once per second at most) and drop savings. */
  backoff(): void {
    const now = this.clock.now();
    if (now - this.lastBackoff < 1000) return; // a burst of parallel rejections is one signal
    this.lastBackoff = now;
    this.refill(now);
    this.rate = Math.max(this.maxRate / 64, this.rate / 2);
    this.tokens = Math.min(this.tokens, 0);
  }

  /** A call succeeded: additive increase back toward the configured pace. */
  recover(): void {
    this.rate = Math.min(this.maxRate, this.rate + this.maxRate / 200);
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  private async acquire(units: number): Promise<void> {
    for (;;) {
      this.refill(this.clock.now());
      // A call costing more than the bucket holds waits for a full bucket.
      const needed = Math.min(units, this.rate);
      if (this.tokens >= needed) {
        this.tokens -= needed;
        return;
      }
      await this.clock.sleep(((needed - this.tokens) / this.rate) * 1000);
    }
  }
}

/** Map over items with at most `limit` promises in flight; preserves order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
