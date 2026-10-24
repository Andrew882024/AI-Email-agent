import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { AccountRepository } from '../db/repositories.js';
import type { Account } from '../domain/types.js';
import type { Logger } from '../logging/system-logger.js';
import { AuthFlowError, isInvalidGrantError, ReauthRequiredError } from './errors.js';
import { GOOGLE_SCOPES, REQUIRED_API_SCOPES } from './scopes.js';
import type { TokenStore } from './token-store.js';

/** Where Google sends the browser back to, under the app's URL. */
export const AUTH_CALLBACK_PATH = '/api/auth/callback';

/** A sign-in in progress: send the browser to `url`; keep `state` and `codeVerifier` for the callback. */
export interface AuthRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

/** How a sign-in ended: the account, or Google must be asked again with the consent screen. */
export type AuthResult = { account: Account } | { consentRequired: true };

/** Everything the rest of the app needs from Google sign-in. */
export interface GoogleAuthProvider {
  /**
   * Start signing in. Without `consent`, someone who already granted access just picks their
   * account; `consent` shows the permission screen (and so always yields a refresh token).
   */
  beginAuth(options?: { consent?: boolean }): Promise<AuthRequest>;
  /** Finish with the code Google redirected back with; persists the account and its refresh token. */
  finishAuth(input: { code: string; codeVerifier: string }): Promise<AuthResult>;
  /**
   * Authorized client for Google API calls, restored from the stored refresh token.
   * Throws ReauthRequiredError when there is no usable token.
   */
  getClient(accountId: string): Promise<OAuth2Client>;
  isConnected(accountId: string): Promise<boolean>;
  /**
   * Forget the account's token after an API call failed with invalid_grant, so the next
   * getClient() asks for reconnection instead of retrying a dead token.
   */
  invalidate(accountId: string): Promise<void>;
  /** Revoke the grant at Google (best effort) and delete the stored token. Keeps mail data. */
  revoke(accountId: string): Promise<void>;
}

export interface GoogleOAuthServiceOptions {
  clientId: string;
  clientSecret: string;
  /** Where Google sends the browser back to, e.g. http://localhost:5173/api/auth/callback. */
  redirectUri: string;
  accounts: AccountRepository;
  tokens: TokenStore;
  logger?: Logger;
  /** Test seam. */
  createClient?: () => OAuth2Client;
}

/**
 * Web OAuth (authorization code + PKCE) with offline access, so the refresh token is kept and
 * background sync runs while the user is away.
 */
export class GoogleOAuthService implements GoogleAuthProvider {
  private readonly clients = new Map<string, Promise<OAuth2Client>>();

  constructor(private readonly options: GoogleOAuthServiceOptions) {}

  async beginAuth({ consent = false }: { consent?: boolean } = {}): Promise<AuthRequest> {
    const state = randomBytes(16).toString('base64url');
    const client = this.newClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: consent ? 'consent' : 'select_account',
      scope: GOOGLE_SCOPES,
      state,
      redirect_uri: this.options.redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return { url, state, codeVerifier: codeVerifier! };
  }

  async finishAuth({ code, codeVerifier }: { code: string; codeVerifier: string }) {
    const client = this.newClient();
    const { tokens } = await client.getToken({
      code,
      codeVerifier,
      redirect_uri: this.options.redirectUri,
    });
    const granted = tokens.scope?.split(' ') ?? [];
    const missing = REQUIRED_API_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length > 0) {
      throw new AuthFlowError(
        `Not all permissions were granted (missing: ${missing.join(', ')}). ` +
          'Sign in again and keep every box checked.',
      );
    }
    if (!tokens.id_token) throw new AuthFlowError('Google did not return an ID token');

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.options.clientId,
    });
    const profile = ticket.getPayload();
    if (!profile?.email) throw new AuthFlowError('Google profile has no email address');

    const account = await this.options.accounts.upsert({
      email: profile.email,
      googleSub: profile.sub,
      displayName: profile.name,
    });
    // Google only issues a refresh token on the consent screen. A returning user who skipped it
    // keeps the stored one; without either, they must see the consent screen.
    if (!tokens.refresh_token) {
      if (!(await this.isConnected(account.id))) return { consentRequired: true as const };
      return { account };
    }
    await this.options.tokens.save(account.id, {
      refreshToken: tokens.refresh_token,
      scopes: granted,
    });
    client.setCredentials(tokens);
    this.watchRotation(account.id, client, granted);
    this.clients.set(account.id, Promise.resolve(client));
    return { account };
  }

  getClient(accountId: string): Promise<OAuth2Client> {
    let client = this.clients.get(accountId);
    if (!client) {
      client = this.restoreClient(accountId);
      this.clients.set(accountId, client);
      client.catch(() => this.clients.delete(accountId));
    }
    return client;
  }

  async isConnected(accountId: string): Promise<boolean> {
    try {
      return (await this.options.tokens.get(accountId)) !== undefined;
    } catch (err) {
      if (err instanceof ReauthRequiredError) return false;
      throw err;
    }
  }

  async invalidate(accountId: string): Promise<void> {
    this.clients.delete(accountId);
    await this.options.tokens.delete(accountId);
  }

  async revoke(accountId: string): Promise<void> {
    let stored;
    try {
      stored = await this.options.tokens.get(accountId);
    } catch (err) {
      if (!(err instanceof ReauthRequiredError)) throw err;
    }
    if (stored) {
      try {
        await this.newClient().revokeToken(stored.refreshToken);
      } catch (err) {
        // Already revoked/expired, or offline: signing out locally must still succeed.
        this.options.logger?.warn({ err, accountId }, 'Google token revocation failed');
      }
    }
    await this.invalidate(accountId);
  }

  private async restoreClient(accountId: string): Promise<OAuth2Client> {
    const stored = await this.options.tokens.get(accountId);
    if (!stored) throw new ReauthRequiredError(accountId, 'not signed in');
    const client = this.newClient();
    client.setCredentials({ refresh_token: stored.refreshToken });
    try {
      await client.getAccessToken(); // fail fast on a dead refresh token
    } catch (err) {
      if (isInvalidGrantError(err)) {
        await this.options.tokens.delete(accountId);
        throw new ReauthRequiredError(accountId, 'Google sign-in expired or was revoked');
      }
      throw err;
    }
    this.watchRotation(accountId, client, stored.scopes);
    return client;
  }

  /** Persist a new refresh token if Google rotates it during a refresh. */
  private watchRotation(accountId: string, client: OAuth2Client, scopes: string[]): void {
    client.on('tokens', (tokens) => {
      if (!tokens.refresh_token) return;
      this.options.tokens
        .save(accountId, {
          refreshToken: tokens.refresh_token,
          scopes: tokens.scope?.split(' ') ?? scopes,
        })
        .catch((err: unknown) =>
          this.options.logger?.error({ err, accountId }, 'failed to persist rotated refresh token'),
        );
    });
  }

  private newClient(): OAuth2Client {
    return (
      this.options.createClient?.() ??
      new OAuth2Client({ clientId: this.options.clientId, clientSecret: this.options.clientSecret })
    );
  }
}
