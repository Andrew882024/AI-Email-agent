import { useAuthStatus } from '../api/queries';
import { useUi } from '../store';

export type Session = 'loading' | 'signed_in' | 'signed_out';

/** Signed in = a Google account is connected and its sign-in still works. */
export function useSession(): Session {
  const auth = useAuthStatus();
  const reauthRequired = useUi((s) => s.reauthRequired);
  if (auth.isPending) return 'loading';
  const ok = auth.data?.account && auth.data.connected && !reauthRequired;
  return ok ? 'signed_in' : 'signed_out';
}
