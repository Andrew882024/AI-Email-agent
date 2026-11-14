/** The account has no usable Google token; the UI should ask the user to reconnect. */
export class ReauthRequiredError extends Error {
  override name = 'ReauthRequiredError';
  constructor(
    readonly accountId: string,
    readonly reason: string,
  ) {
    super(`Google account must be reconnected: ${reason}`);
  }
}

/** The interactive sign-in did not complete (denied, timed out, missing permissions, ...). */
export class AuthFlowError extends Error {
  override name = 'AuthFlowError';
}

/** Google rejected the refresh token: expired (7 days in "Testing" mode), revoked, or password changed. */
export function isInvalidGrantError(err: unknown): boolean {
  const e = err as { response?: { data?: { error?: unknown } }; message?: unknown } | undefined;
  return (
    e?.response?.data?.error === 'invalid_grant' ||
    (typeof e?.message === 'string' && e.message.includes('invalid_grant'))
  );
}
