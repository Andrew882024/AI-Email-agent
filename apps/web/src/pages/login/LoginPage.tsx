import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { api } from '../../api/client';
import { useAuthStatus } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useUi } from '../../store';

/**
 * The login page (/login): connect a Google account, or reconnect one whose sign-in expired.
 * Once signed in, the router (router/routes.tsx) moves on to the mail page.
 */
export function LoginPage() {
  const auth = useAuthStatus();
  const setReauthRequired = useUi((s) => s.setReauthRequired);
  const qc = useQueryClient();
  const login = useMutation({
    mutationFn: () => api('/api/auth/login', { method: 'POST' }),
    onSuccess: () => {
      setReauthRequired(false);
      void qc.invalidateQueries();
    },
  });

  const account = auth.data?.account;

  return (
    <div className="flex h-screen items-center justify-center bg-[#f6f8fc] text-[#1f1f1f]">
      <div className="w-[440px] rounded-2xl bg-white p-8 text-center shadow-sm">
        <Mail className="mx-auto h-10 w-10 text-blue-600" />
        <h1 className="mt-4 text-xl font-medium">
          {account ? 'Reconnect your Google account' : 'Connect your Google account'}
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          {account
            ? `Google sign-in for ${account.email} expired or was revoked. Sign in again to keep your mail in sync.`
            : 'AI Email Agent keeps a local copy of your Gmail and works on it with you. Sign in once; you stay signed in.'}
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          {login.isPending ? (
            <p className="flex items-center gap-2 text-sm text-gray-700">
              <Spinner className="h-4 w-4 text-blue-600" /> Finish signing in in your browser…
            </p>
          ) : (
            <Button variant="primary" onClick={() => login.mutate()}>
              Continue with Google
            </Button>
          )}
          {login.error && <p className="text-sm text-red-700">{login.error.message}</p>}
          <p className="text-xs text-gray-500">
            Keep every permission checked — the app needs Gmail, Tasks, and Drive access.
          </p>
        </div>
      </div>
    </div>
  );
}
