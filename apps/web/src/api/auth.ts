import { z } from 'zod';
import { Ok, optional, request } from './client';

export const AuthStatus = z.object({
  account: z
    .object({ id: z.string(), email: z.string(), displayName: optional(z.string()) })
    .nullable(),
  connected: z.boolean(),
});
export type AuthStatus = z.output<typeof AuthStatus>;

export const getAuthStatus = () => request(AuthStatus, '/api/auth/status');

/** Opens Google sign-in in the system browser; resolves once the user has finished. */
export const login = () =>
  request(
    z.object({ account: z.object({ id: z.string(), email: z.string() }) }),
    '/api/auth/login',
    { method: 'POST' },
  );

/** Signs out and revokes the app's Google access. */
export const logout = () => request(Ok, '/api/auth/logout', { method: 'POST' });
