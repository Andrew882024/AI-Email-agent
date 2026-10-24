import { useMutation, useQuery } from '@tanstack/react-query';
import { deleteAccount, getAuthStatus, logout } from '../api/auth';
import { useUi } from './store';

export function useAuthStatus() {
  return useQuery({ queryKey: ['auth'], queryFn: getAuthStatus });
}

export type Session = 'loading' | 'signed_in' | 'signed_out';

/** Signed in = this browser has a session and the account's Google access still works. */
export function useSession(): Session {
  const auth = useAuthStatus();
  const reauthRequired = useUi((s) => s.reauthRequired);
  if (auth.isPending) return 'loading';
  const ok = auth.data?.account && auth.data.connected && !reauthRequired;
  return ok ? 'signed_in' : 'signed_out';
}

// After signing out or deleting the account, the page is reloaded on /login so nothing of this
// account (cached mail, open drafts, chat) stays in memory for whoever uses the browser next.
const reloadOnLogin = () => window.location.assign('/login');

/** Sign this browser out. */
export function useLogout() {
  return useMutation({ mutationFn: logout, onSuccess: reloadOnLogin });
}

/** Delete the account and everything the app keeps for it. */
export function useDeleteAccount() {
  return useMutation({ mutationFn: deleteAccount, onSuccess: reloadOnLogin });
}
