import { type ReactNode, useEffect } from 'react';
import { Spinner } from '../components/ui/Spinner';
import { LoginPage } from '../pages/login/LoginPage';
import { MailPage } from '../pages/mail/MailPage';
import { type AppLocation, navigate, useLocation } from './location';
import { parseLoginHash } from './login-params';
import { formatMailHash, parseMailHash } from './mail-params';
import { type Session, useSession } from '../state/auth';

interface RouteDef {
  path: string;
  /** Where to send the user instead, if anywhere. Re-checked whenever the location or session changes. */
  redirect?: (session: Exclude<Session, 'loading'>, location: AppLocation) => string | undefined;
  /** The page, with the parameters parsed from the location. */
  render?: (location: AppLocation) => ReactNode;
}

/**
 * Every page of the app. Redirects keep the "#..." part, so a link like /#inbox/p4/1a13… still
 * lands on that conversation after the entry redirect and, if needed, signing in.
 */
export const routes: RouteDef[] = [
  {
    // Entry point: decides where to go.
    path: '/',
    redirect: (session, { hash }) => (session === 'signed_in' ? `/mail${hash}` : `/login${hash}`),
  },
  {
    path: '/login',
    // A failed sign-in's error is the login page's own; anything else is where to go afterwards.
    redirect: (session, { hash }) =>
      session !== 'signed_in' ? undefined : parseLoginHash(hash).error ? '/mail' : `/mail${hash}`,
    render: ({ hash }) => <LoginPage params={parseLoginHash(hash)} />,
  },
  {
    path: '/mail',
    redirect: (session, { hash }) => {
      if (session === 'signed_out') return `/login${hash}`;
      const canonical = formatMailHash(parseMailHash(hash)); // e.g. "" → "#inbox"
      return canonical === hash ? undefined : `/mail${canonical}`;
    },
    // The one place the mail page's parameters are parsed from the URL.
    render: ({ hash }) => <MailPage params={parseMailHash(hash)} />,
  },
];

/** Renders the page for the current location, after applying the route's redirect. */
export function Router() {
  const location = useLocation();
  const session = useSession();
  const route = routes.find((r) => r.path === location.path);
  const target =
    route === undefined
      ? '/' // unknown path: start over at the entry
      : session === 'loading'
        ? undefined
        : route.redirect?.(session, location);

  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [target]);

  if (!route?.render || target || session === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return route.render(location);
}
