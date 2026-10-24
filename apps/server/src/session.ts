// Browser sign-in sessions: an HttpOnly cookie holding a random token; the database keeps only
// its SHA-256, so a leaked table can't be used to sign in.
import { createHash, randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRepository } from './core/index.js';

export const SESSION_COOKIE = 'sid';
const SESSION_MS = 30 * 24 * 3600_000;
/** Sliding expiry, but at most one write per session per day. */
const TOUCH_AFTER_MS = 24 * 3600_000;

const hash = (token: string) => createHash('sha256').update(token).digest('base64url');

export class Sessions {
  constructor(
    private readonly repo: SessionRepository,
    /** Send the cookie over HTTPS only (when the app is served over HTTPS). */
    private readonly secure: boolean,
  ) {}

  cookieOptions(maxAgeMs: number): CookieSerializeOptions {
    return {
      path: '/',
      httpOnly: true,
      sameSite: 'lax', // sent when Google redirects back (a top-level GET), not on cross-site POSTs
      secure: this.secure,
      maxAge: Math.floor(maxAgeMs / 1000),
    };
  }

  /** Sign this browser in as the account. */
  async create(reply: FastifyReply, accountId: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.repo.create({
      id: hash(token),
      accountId,
      expiresAt: new Date(Date.now() + SESSION_MS),
    });
    reply.setCookie(SESSION_COOKIE, token, this.cookieOptions(SESSION_MS));
  }

  /** The account this browser is signed in as, if any; extends the session while it is used. */
  async accountOf(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return undefined;
    const session = await this.repo.get(hash(token));
    if (!session) return undefined;
    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
      await this.repo.touch(session.id, new Date(Date.now() + SESSION_MS));
      reply.setCookie(SESSION_COOKIE, token, this.cookieOptions(SESSION_MS));
    }
    return session.accountId;
  }

  /** Sign this browser out. */
  async end(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await this.repo.delete(hash(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
