// Storage contracts of the auth module's tables (accounts, sessions); db code lives next to them.
import type { Account } from '../shared/types.js';

export interface AccountRepository {
  /** Insert, or update email/displayName of the account with the same googleSub. */
  upsert(input: { email: string; googleSub: string; displayName?: string }): Promise<Account>;
  getById(id: string): Promise<Account | undefined>;
  list(): Promise<Account[]>;
  updateSyncState(id: string, state: { historyId?: string; lastFullSyncAt?: Date }): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface StoredOAuthToken {
  accountId: string;
  /** Ciphertext produced by a SecretCipher; this layer never sees the plaintext token. */
  encryptedRefreshToken: string;
  scopes: string[];
  updatedAt: Date;
}

export interface StoredSession {
  /** SHA-256 of the cookie token. */
  id: string;
  accountId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

/** Browser sign-ins. */
export interface SessionRepository {
  create(session: { id: string; accountId: string; expiresAt: Date }): Promise<void>;
  /** The session, if it exists and hasn't expired. */
  get(id: string): Promise<StoredSession | undefined>;
  /** Mark as used now and push the expiry out. */
  touch(id: string, expiresAt: Date): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface OAuthTokenRepository {
  get(accountId: string): Promise<StoredOAuthToken | undefined>;
  /** Insert or replace the account's token. */
  save(
    accountId: string,
    token: { encryptedRefreshToken: string; scopes: string[] },
  ): Promise<void>;
  delete(accountId: string): Promise<void>;
}
