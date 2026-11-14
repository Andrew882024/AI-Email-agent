import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { getAuthStatus } from '../api/auth';

export type Session =
  | { state: 'loading' }
  | { state: 'signed_in'; email: string }
  | { state: 'signed_out' }
  /** `code` "forbidden": the server doesn't allow this extension's origin. */
  | { state: 'unreachable'; code: string; message: string };

/**
 * Whether this browser is signed in to the app. Rechecked when the panel regains focus, so signing
 * in in another tab shows up on coming back.
 */
export function useSession(): Session & { recheck: () => void } {
  const auth = useQuery({
    queryKey: ['auth'],
    queryFn: getAuthStatus,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const recheck = () => void auth.refetch();
  if (auth.isPending) return { state: 'loading', recheck };
  if (auth.error)
    return {
      state: 'unreachable',
      code: auth.error instanceof ApiError ? auth.error.code : 'error',
      message: auth.error instanceof ApiError ? auth.error.message : String(auth.error),
      recheck,
    };
  const account = auth.data.account;
  return account && auth.data.connected
    ? { state: 'signed_in', email: account.email, recheck }
    : { state: 'signed_out', recheck };
}
