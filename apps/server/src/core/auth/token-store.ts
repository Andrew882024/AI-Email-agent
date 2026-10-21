import type { OAuthTokenRepository } from '../db/repositories.js';
import { ReauthRequiredError } from './errors.js';
import type { SecretCipher } from './secret-cipher.js';

export interface StoredRefreshToken {
  refreshToken: string;
  scopes: string[];
}

/** Long-lived Google credentials per account. */
export interface TokenStore {
  get(accountId: string): Promise<StoredRefreshToken | undefined>;
  save(accountId: string, token: StoredRefreshToken): Promise<void>;
  delete(accountId: string): Promise<void>;
}

/** Persists refresh tokens through the repository, encrypted with the injected cipher. */
export class EncryptedTokenStore implements TokenStore {
  constructor(
    private readonly repo: OAuthTokenRepository,
    private readonly cipher: SecretCipher,
  ) {}

  async get(accountId: string): Promise<StoredRefreshToken | undefined> {
    const stored = await this.repo.get(accountId);
    if (!stored) return undefined;
    let refreshToken: string;
    try {
      refreshToken = await this.cipher.decrypt(stored.encryptedRefreshToken);
    } catch {
      throw new ReauthRequiredError(
        accountId,
        'stored token could not be decrypted (was APP_SECRET_KEY changed?)',
      );
    }
    return { refreshToken, scopes: stored.scopes };
  }

  async save(accountId: string, token: StoredRefreshToken): Promise<void> {
    await this.repo.save(accountId, {
      encryptedRefreshToken: await this.cipher.encrypt(token.refreshToken),
      scopes: token.scopes,
    });
  }

  async delete(accountId: string): Promise<void> {
    await this.repo.delete(accountId);
  }
}
