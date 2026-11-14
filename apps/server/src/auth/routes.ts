import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../shared/http.js';
import type { Logger } from '../shared/logging/system-logger.js';
import type { Account } from '../shared/types.js';
import { AuthFlowError } from './errors.js';
import type { GoogleAuthProvider } from './google-auth.js';
import type { AccountRepository } from './repositories.js';
import type { SecretCipher } from './secret-cipher.js';
import { SESSION_COOKIE, type Sessions } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in account of this request's session, if any. */
    accountId?: string;
  }
}

/** Holds the OAuth state and PKCE verifier between leaving for Google and coming back. */
const SIGN_IN_COOKIE = 'sign_in';
const SIGN_IN_MS = 10 * 60_000;

/** Who a request acts as; every module's routes use it. */
export interface RequestAccount {
  /** onRequest hook: resolves the session cookie to `req.accountId`. */
  hook(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** The account this request's browser is signed in as. */
  currentAccount(req: FastifyRequest): Promise<Account | undefined>;
  /** Like currentAccount, but a 401 when signed out. */
  requireAccount(req: FastifyRequest): Promise<Account>;
}

export function requestAccount(sessions: Sessions, accounts: AccountRepository): RequestAccount {
  const currentAccount = async (req: FastifyRequest) =>
    req.accountId ? accounts.getById(req.accountId) : undefined;
  return {
    async hook(req, reply) {
      req.accountId = await sessions.accountOf(req, reply);
    },
    currentAccount,
    async requireAccount(req) {
      const account = await currentAccount(req);
      if (!account) throw new HttpError(401, 'not_signed_in', 'Sign in to continue');
      return account;
    },
  };
}

export interface AuthRouteDeps {
  auth: GoogleAuthProvider;
  /** Seals the short-lived sign-in cookie (OAuth state and PKCE verifier). */
  cipher: SecretCipher;
  sessions: Sessions;
  accounts: AccountRepository;
  access: RequestAccount;
  appUrl: URL;
  logger: Logger;
  /** A sign-in finished: start the account's background work. */
  onSignedIn(accountId: string): void;
  /** Before an account is deleted: stop its work and erase what other modules keep outside it. */
  beforeAccountDelete(accountId: string): Promise<void>;
}

/** Sign in with Google, sign out, auth status and account deletion. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { auth, cipher, sessions, access, appUrl } = deps;

  app.get('/api/auth/status', async (req) => {
    const account = await access.currentAccount(req);
    return {
      account: account
        ? { id: account.id, email: account.email, displayName: account.displayName }
        : null,
      connected: account ? await auth.isConnected(account.id) : false,
    };
  });

  const signInCookie = { path: '/api/auth', httpOnly: true, sameSite: 'lax' as const };
  const signInState = z.object({ state: z.string(), codeVerifier: z.string() });

  /** Sign in: off to Google, which comes back to /api/auth/callback. `?consent=1` asks for every permission again. */
  app.get<{ Querystring: { consent?: string } }>('/api/auth/google', async (req, reply) => {
    const request = await auth.beginAuth({ consent: req.query.consent === '1' });
    const sealed = await cipher.encrypt(
      JSON.stringify({ state: request.state, codeVerifier: request.codeVerifier }),
    );
    reply.setCookie(SIGN_IN_COOKIE, sealed, {
      ...signInCookie,
      secure: appUrl.protocol === 'https:',
      maxAge: SIGN_IN_MS / 1000,
    });
    return reply.redirect(request.url);
  });

  /** Google sends the browser back here; on success it is signed in and lands on the mail page. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/callback',
    async (req, reply) => {
      const sealed = req.cookies[SIGN_IN_COOKIE];
      reply.clearCookie(SIGN_IN_COOKIE, { path: signInCookie.path });
      const fail = (message: string) =>
        reply.redirect(`/login#error=${encodeURIComponent(message)}`);
      if (req.query.error)
        return fail(
          req.query.error === 'access_denied'
            ? 'Sign-in was cancelled.'
            : `Google sign-in failed (${req.query.error}).`,
        );
      const saved = sealed
        ? await cipher
            .decrypt(sealed)
            .then((json) => signInState.parse(JSON.parse(json)))
            .catch(() => undefined)
        : undefined;
      if (!saved || !req.query.code || saved.state !== req.query.state)
        return fail('That sign-in expired or was started in another tab. Try again.');

      let result;
      try {
        result = await auth.finishAuth({ code: req.query.code, codeVerifier: saved.codeVerifier });
      } catch (err) {
        if (err instanceof AuthFlowError) return fail(err.message);
        deps.logger.error({ err }, 'sign-in failed');
        return fail('Sign-in failed. Try again.');
      }
      if ('consentRequired' in result) return reply.redirect('/api/auth/google?consent=1');
      await sessions.end(req, reply); // a previous account's session in this browser
      await sessions.create(reply, result.account.id);
      deps.onSignedIn(result.account.id);
      return reply.redirect('/mail');
    },
  );

  /** Sign this browser out. Background sync and workflows keep running. */
  app.post('/api/auth/logout', async (req, reply) => {
    await sessions.end(req, reply);
    return { ok: true };
  });

  /**
   * Delete the account: revoke Google access and erase everything this app keeps for it (mail
   * copy, index, chats, memory, workflows, uploads, logs). Gmail and Drive are not touched.
   */
  app.delete('/api/account', async (req, reply) => {
    const account = await access.requireAccount(req);
    await auth.revoke(account.id);
    await deps.beforeAccountDelete(account.id);
    await deps.accounts.delete(account.id); // the rest goes with it (ON DELETE CASCADE)
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
