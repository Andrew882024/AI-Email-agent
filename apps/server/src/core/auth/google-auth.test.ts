import { type Credentials, OAuth2Client } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';
import type { AccountRepository } from '../db/repositories.js';
import type { Account } from '../domain/types.js';
import { AuthFlowError, isInvalidGrantError, ReauthRequiredError } from './errors.js';
import { GoogleOAuthService } from './google-auth.js';
import { GOOGLE_SCOPES } from './scopes.js';
import type { StoredRefreshToken, TokenStore } from './token-store.js';

const CLIENT_ID = 'client.apps.googleusercontent.com';
const GOOD_TOKENS: Credentials = {
  refresh_token: '1//refresh',
  access_token: 'access',
  id_token: 'id-token',
  scope: GOOGLE_SCOPES.join(' '),
  expiry_date: Date.now() + 3_600_000,
};
const invalidGrant = () =>
  Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });

class MemoryAccounts implements AccountRepository {
  readonly rows = new Map<string, Account>();
  async upsert(input: { email: string; googleSub: string; displayName?: string }) {
    const existing = [...this.rows.values()].find((a) => a.googleSub === input.googleSub);
    const account: Account = {
      id: existing?.id ?? `acc-${this.rows.size + 1}`,
      ...input,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(account.id, account);
    return account;
  }
  async getById(id: string) {
    return this.rows.get(id);
  }
  async list() {
    return [...this.rows.values()];
  }
  async updateSyncState() {}
  async delete(id: string) {
    this.rows.delete(id);
  }
}

class MemoryTokens implements TokenStore {
  readonly rows = new Map<string, StoredRefreshToken>();
  async get(id: string) {
    return this.rows.get(id);
  }
  async save(id: string, token: StoredRefreshToken) {
    this.rows.set(id, token);
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

interface Scenario {
  tokens?: Credentials;
  accessTokenError?: () => unknown;
  revokeError?: unknown;
}

function setup(
  scenario: Scenario = {},
  stores = { accounts: new MemoryAccounts(), tokens: new MemoryTokens() },
) {
  const clients: OAuth2Client[] = [];
  const createClient = () => {
    const client = new OAuth2Client({ clientId: CLIENT_ID, clientSecret: 'secret' });
    vi.spyOn(client, 'getToken').mockImplementation(
      async () => ({ tokens: scenario.tokens ?? GOOD_TOKENS, res: null }) as never,
    );
    vi.spyOn(client, 'verifyIdToken').mockImplementation(
      async () =>
        ({ getPayload: () => ({ sub: 'google-sub', email: 'me@gmail.com', name: 'Me' }) }) as never,
    );
    vi.spyOn(client, 'getAccessToken').mockImplementation(async () => {
      const error = scenario.accessTokenError?.();
      if (error) throw error;
      return { token: 'access' } as never;
    });
    vi.spyOn(client, 'revokeToken').mockImplementation(async () => {
      if (scenario.revokeError) throw scenario.revokeError;
      return {} as never;
    });
    clients.push(client);
    return client;
  };
  // Plays the user's browser: follows the consent URL straight to the redirect with a code.
  const openedUrls: URL[] = [];
  const openExternal = async (url: string) => {
    const u = new URL(url);
    openedUrls.push(u);
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    redirect.search = new URLSearchParams({
      state: u.searchParams.get('state')!,
      code: 'the-code',
    }).toString();
    await fetch(redirect);
  };
  const service = new GoogleOAuthService({
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    ...stores,
    openExternal,
    createClient,
    timeoutMs: 5000,
  });
  return { service, clients, openedUrls, ...stores };
}

describe('GoogleOAuthService', () => {
  it('signs in with offline access + PKCE and persists the account and refresh token', async () => {
    const { service, clients, openedUrls, accounts, tokens } = setup();
    const account = await service.startAuth();

    expect(account).toMatchObject({
      email: 'me@gmail.com',
      googleSub: 'google-sub',
      displayName: 'Me',
    });
    expect(accounts.rows.size).toBe(1);
    expect(tokens.rows.get(account.id)).toEqual({
      refreshToken: '1//refresh',
      scopes: GOOGLE_SCOPES,
    });

    const params = openedUrls[0]!.searchParams;
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('scope')?.split(' ')).toEqual(GOOGLE_SCOPES);
    expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);

    expect(clients[0]!.getToken).toHaveBeenCalledWith({
      code: 'the-code',
      codeVerifier: expect.any(String),
      redirect_uri: params.get('redirect_uri'),
    });
    expect(clients[0]!.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-token',
      audience: CLIENT_ID,
    });
    // The signed-in client is reused without another network round-trip.
    expect(await service.getClient(account.id)).toBe(clients[0]);
  });

  it('restores the session after a restart without signing in again', async () => {
    const first = setup();
    const account = await first.service.startAuth();

    const restarted = setup({}, { accounts: first.accounts, tokens: first.tokens });
    const client = await restarted.service.getClient(account.id);
    expect(client.credentials.refresh_token).toBe('1//refresh');
    expect(client.getAccessToken).toHaveBeenCalledOnce();
    expect(await restarted.service.getClient(account.id)).toBe(client);
    expect(restarted.clients).toHaveLength(1);
    expect(restarted.openedUrls).toHaveLength(0);
  });

  it('refuses a sign-in where permissions were unticked', async () => {
    const scope = GOOGLE_SCOPES.filter((s) => !s.endsWith('gmail.modify')).join(' ');
    const { service, accounts, tokens } = setup({ tokens: { ...GOOD_TOKENS, scope } });
    await expect(service.startAuth()).rejects.toThrow(AuthFlowError);
    await expect(setup({ tokens: { ...GOOD_TOKENS, scope } }).service.startAuth()).rejects.toThrow(
      /missing: .*gmail\.modify/,
    );
    expect(accounts.rows.size + tokens.rows.size).toBe(0);
  });

  it('refuses a sign-in without a refresh token', async () => {
    const { service } = setup({ tokens: { ...GOOD_TOKENS, refresh_token: undefined } });
    await expect(service.startAuth()).rejects.toThrow('did not return a refresh token');
  });

  it('asks for reconnection and forgets the token when Google says invalid_grant', async () => {
    const first = setup();
    const account = await first.service.startAuth();
    const restarted = setup(
      { accessTokenError: invalidGrant },
      { accounts: first.accounts, tokens: first.tokens },
    );

    const err = await restarted.service.getClient(account.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as ReauthRequiredError).accountId).toBe(account.id);
    expect(first.tokens.rows.size).toBe(0);
    expect(await restarted.service.isConnected(account.id)).toBe(false);
  });

  it('keeps the token on transient errors and retries on the next call', async () => {
    const first = setup();
    const account = await first.service.startAuth();
    let offline = true;
    const restarted = setup(
      {
        accessTokenError: () =>
          offline ? new Error('ENOTFOUND oauth2.googleapis.com') : undefined,
      },
      { accounts: first.accounts, tokens: first.tokens },
    );
    await expect(restarted.service.getClient(account.id)).rejects.toThrow('ENOTFOUND');
    expect(first.tokens.rows.size).toBe(1);

    offline = false; // the failed attempt must not be cached
    const client = await restarted.service.getClient(account.id);
    expect(client.credentials.refresh_token).toBe('1//refresh');
  });

  it('throws ReauthRequiredError for an account that never signed in', async () => {
    await expect(setup().service.getClient('nope')).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it('revokes at Google and deletes locally, even if revocation fails', async () => {
    for (const revokeError of [undefined, new Error('offline')]) {
      const { service, tokens } = setup({ revokeError });
      const account = await service.startAuth();
      await service.revoke(account.id);
      expect(tokens.rows.size).toBe(0);
      await expect(service.getClient(account.id)).rejects.toBeInstanceOf(ReauthRequiredError);
    }
    const { service, clients } = setup();
    const account = await service.startAuth();
    await service.revoke(account.id);
    expect(clients.at(-1)!.revokeToken).toHaveBeenCalledWith('1//refresh');
  });

  it('invalidate() drops the cached client and the stored token', async () => {
    const { service, tokens } = setup();
    const account = await service.startAuth();
    await service.invalidate(account.id);
    expect(tokens.rows.size).toBe(0);
    await expect(service.getClient(account.id)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it('persists a rotated refresh token', async () => {
    const { service, clients, tokens } = setup();
    const account = await service.startAuth();
    clients[0]!.emit('tokens', { refresh_token: '1//rotated', access_token: 'new' });
    await vi.waitFor(() => expect(tokens.rows.get(account.id)?.refreshToken).toBe('1//rotated'));
    expect(tokens.rows.get(account.id)?.scopes).toEqual(GOOGLE_SCOPES);
  });
});

describe('isInvalidGrantError', () => {
  it('recognizes gaxios responses and plain messages', () => {
    expect(isInvalidGrantError(invalidGrant())).toBe(true);
    expect(
      isInvalidGrantError(new Error('invalid_grant: Token has been expired or revoked.')),
    ).toBe(true);
    expect(isInvalidGrantError(new Error('ECONNRESET'))).toBe(false);
    expect(isInvalidGrantError(undefined)).toBe(false);
  });
});
