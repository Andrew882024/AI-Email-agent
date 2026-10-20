import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { api } from '../api/client';
import { useAuthStatus } from '../api/queries';
import { useUi } from '../store';
import { Button, Spinner } from './ui';

/** Shown until a Google account is connected, and again when its sign-in expires. */
export function ConnectGoogleModal() {
  const auth = useAuthStatus();
  const reauthRequired = useUi((s) => s.reauthRequired);
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
  const open = auth.isSuccess && (!account || !auth.data.connected || reauthRequired);
  const reconnect = !!account;

  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-8 text-center shadow-xl"
        >
          <Mail className="mx-auto h-10 w-10 text-blue-600" />
          <Dialog.Title className="mt-4 text-xl font-medium">
            {reconnect ? 'Reconnect your Google account' : 'Connect your Google account'}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-gray-600">
            {reconnect
              ? `Google sign-in for ${account.email} expired or was revoked. Sign in again to keep your mail in sync.`
              : 'AI Email Agent keeps a local copy of your Gmail and works on it with you. Sign in once; you stay signed in.'}
          </Dialog.Description>
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
