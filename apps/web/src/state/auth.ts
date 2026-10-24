import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthStatus, login, logout } from '../api/auth';
import { useUi } from './store';

export function useAuthStatus() {
  return useQuery({ queryKey: ['auth'], queryFn: getAuthStatus });
}

export type Session = 'loading' | 'signed_in' | 'signed_out';

/** Signed in = a Google account is connected and its sign-in still works. */
export function useSession(): Session {
  const auth = useAuthStatus();
  const reauthRequired = useUi((s) => s.reauthRequired);
  if (auth.isPending) return 'loading';
  const ok = auth.data?.account && auth.data.connected && !reauthRequired;
  return ok ? 'signed_in' : 'signed_out';
}

/** Sign in with Google (the browser flow), then reload everything. */
export function useLogin() {
  const qc = useQueryClient();
  const setReauthRequired = useUi((s) => s.setReauthRequired);
  return useMutation({
    mutationFn: login,
    onSuccess: () => {
      setReauthRequired(false);
      void qc.invalidateQueries();
    },
  });
}

/** Sign out (revokes Google access), then reload everything. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: logout, onSuccess: () => void qc.invalidateQueries() });
}
