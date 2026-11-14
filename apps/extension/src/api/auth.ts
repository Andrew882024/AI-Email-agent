import { z } from 'zod';
import { optional, request } from './client';

export const AuthStatus = z.object({
  account: z
    .object({ id: z.string(), email: z.string(), displayName: optional(z.string()) })
    .nullable(),
  connected: z.boolean(),
});
export type AuthStatus = z.output<typeof AuthStatus>;

/** Who this browser is signed in as (`account: null` when signed out). */
export const getAuthStatus = () => request(AuthStatus, '/api/auth/status');
