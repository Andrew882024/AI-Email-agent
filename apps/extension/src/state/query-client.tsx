import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

/** The session ended (expired, or signed out in the app): recheck, so the panel shows sign-in. */
const onError = (err: Error) => {
  if (err instanceof ApiError && err.code === 'not_signed_in')
    void queryClient.invalidateQueries({ queryKey: ['auth'] });
};

/** The cache of server data. Only code in state/ reads or writes it. */
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Client errors (404, not signed in, a response that failed validation) and an unreachable
      // server won't fix themselves by retrying right away.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

/** Makes the global state available to the side panel. */
export function StateProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
