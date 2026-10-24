import { z } from 'zod';
import { Ok, optional, request } from './client';

export const AuthStatus = z.object({
  account: z
    .object({ id: z.string(), email: z.string(), displayName: optional(z.string()) })
    .nullable(),
  connected: z.boolean(),
});
export type AuthStatus = z.output<typeof AuthStatus>;

/** Who this browser is signed in as (`account: null` when signed out). */
export const getAuthStatus = () => request(AuthStatus, '/api/auth/status');

/** Sign in: the browser goes here, on to Google, and comes back signed in on /mail. */
export const GOOGLE_SIGN_IN_URL = '/api/auth/google';

/** Signs this browser out; background sync for the account keeps running. */
export const logout = () => request(Ok, '/api/auth/logout', { method: 'POST' });

/** Deletes the account: revokes Google access and erases everything the app keeps for it. */
export const deleteAccount = () => request(Ok, '/api/account', { method: 'DELETE' });
