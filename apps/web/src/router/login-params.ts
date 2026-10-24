// The login page's parameters live after "#", like the mail page's:
//   /login#error=<why the last sign-in failed>   (set by the server's Google callback)

export interface LoginParams {
  /** Why the last sign-in didn't work, to show the user. */
  error?: string;
}

export function parseLoginHash(hash: string): LoginParams {
  const error = new URLSearchParams(hash.replace(/^#/, '')).get('error');
  return error ? { error } : {};
}
