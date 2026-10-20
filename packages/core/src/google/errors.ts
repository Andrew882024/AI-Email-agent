/** The history id is too old for users.history.list (Gmail keeps roughly a week); resync fully. */
export class HistoryExpiredError extends Error {
  override name = 'HistoryExpiredError';
}

type GoogleErrorShape = {
  status?: unknown;
  code?: unknown;
  response?: { status?: unknown; data?: { error?: { errors?: { reason?: unknown }[] } } };
};

export function httpStatus(err: unknown): number | undefined {
  const e = err as GoogleErrorShape | undefined;
  const status = e?.response?.status ?? e?.status ?? e?.code;
  return typeof status === 'number' ? status : undefined;
}

function reasons(err: unknown): unknown[] {
  return (
    (err as GoogleErrorShape | undefined)?.response?.data?.error?.errors?.map((e) => e.reason) ?? []
  );
}

export const isNotFound = (err: unknown) => httpStatus(err) === 404;

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
]);

/** Connection-level failure (offline, DNS, reset), looking through `cause` chains. */
export function isNetworkError(err: unknown): boolean {
  let e = err as
    { code?: unknown; cause?: unknown; name?: unknown; response?: unknown } | undefined;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = e.code;
    if (typeof code === 'string' && (NETWORK_CODES.has(code) || code.startsWith('UND_ERR'))) {
      return true;
    }
    if (e.name === 'GaxiosError' && !e.response) return true; // request never got a response
    if ((e as unknown) instanceof TypeError && (e as Error).message === 'fetch failed') return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Quota / rate-limit rejection (needs a longer wait than other transient errors). */
export function isRateLimitError(err: unknown): boolean {
  const status = httpStatus(err);
  return (
    status === 429 ||
    (status === 403 &&
      reasons(err).some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded'))
  );
}

/** Server-requested wait from a Retry-After header (seconds or HTTP date), if any. */
export function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { response?: { headers?: unknown } } | undefined)?.response?.headers;
  const value =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers as Record<string, string> | undefined)?.['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Worth retrying: rate limits, server errors and network failures. */
export function isRetryableGoogleError(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === undefined) return isNetworkError(err);
  return status >= 500 || isRateLimitError(err);
}
