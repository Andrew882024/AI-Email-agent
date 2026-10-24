import { Mail } from 'lucide-react';
import { useState } from 'react';
import { GOOGLE_SIGN_IN_URL } from '../../api/auth';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import type { LoginParams } from '../../router/login-params';
import { useAuthStatus } from '../../state/auth';

/**
 * The login page (/login): sign in with Google, or reconnect an account whose Google access
 * expired. Signing in leaves for Google and comes back on the mail page; if it fails, it comes
 * back here with `params.error`.
 */
export function LoginPage({ params }: { params: LoginParams }) {
  const auth = useAuthStatus();
  const [leaving, setLeaving] = useState(false);
  const account = auth.data?.account;

  return (
    <div className="flex h-screen items-center justify-center bg-[#f6f8fc] text-[#1f1f1f]">
      <div className="w-[440px] rounded-2xl bg-white p-8 text-center shadow-sm">
        <Mail className="mx-auto h-10 w-10 text-blue-600" />
        <h1 className="mt-4 text-xl font-medium">
          {account ? 'Reconnect your Google account' : 'Sign in to AI Email Agent'}
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          {account
            ? `Google access for ${account.email} expired or was revoked. Sign in again to keep your mail in sync.`
            : 'An AI assistant for your Gmail: search, organize and automate your mail. Sign in with the Google account whose mail you want to use.'}
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          {leaving ? (
            <p className="flex items-center gap-2 text-sm text-gray-700">
              <Spinner className="h-4 w-4 text-blue-600" /> Taking you to Google…
            </p>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                setLeaving(true);
                window.location.assign(GOOGLE_SIGN_IN_URL);
              }}
            >
              Continue with Google
            </Button>
          )}
          {params.error && <p className="text-sm text-red-700">{params.error}</p>}
          <p className="text-xs text-gray-500">
            Keep every permission checked — the app needs Gmail, Tasks, and Drive access.
          </p>
        </div>
      </div>
    </div>
  );
}
