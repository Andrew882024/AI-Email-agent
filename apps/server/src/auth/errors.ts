/** The interactive sign-in did not complete (denied, timed out, missing permissions, ...). */
export class AuthFlowError extends Error {
  override name = 'AuthFlowError';
}
