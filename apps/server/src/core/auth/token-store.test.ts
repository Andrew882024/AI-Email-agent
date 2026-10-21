import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from '../../../test/helpers/db.js';
import { createPgRepositories } from '../db/pg/index.js';
import type { Repositories } from '../db/repositories.js';
import { ReauthRequiredError } from './errors.js';
import { AesGcmSecretCipher } from './secret-cipher.js';
import { EncryptedTokenStore } from './token-store.js';

describe.skipIf(!testDatabaseUrl)('EncryptedTokenStore', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
    accountId = (await repos.accounts.upsert({ email: 'me@example.com', googleSub: 'sub' })).id;
  });
  afterAll(() => t?.destroy());

  it('stores only ciphertext and survives a restart (new store instance)', async () => {
    const key = 'a'.repeat(32);
    await new EncryptedTokenStore(repos.oauthTokens, new AesGcmSecretCipher(key)).save(accountId, {
      refreshToken: '1//secret-refresh',
      scopes: ['s1', 's2'],
    });

    const raw = await repos.oauthTokens.get(accountId);
    expect(raw?.encryptedRefreshToken).not.toContain('secret-refresh');
    expect(raw?.scopes).toEqual(['s1', 's2']);

    const restarted = new EncryptedTokenStore(repos.oauthTokens, new AesGcmSecretCipher(key));
    expect(await restarted.get(accountId)).toEqual({
      refreshToken: '1//secret-refresh',
      scopes: ['s1', 's2'],
    });
  });

  it('asks for reconnection when the key changed', async () => {
    const store = new EncryptedTokenStore(
      repos.oauthTokens,
      new AesGcmSecretCipher('b'.repeat(32)),
    );
    await expect(store.get(accountId)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it('deletes', async () => {
    const store = new EncryptedTokenStore(
      repos.oauthTokens,
      new AesGcmSecretCipher('a'.repeat(32)),
    );
    await store.delete(accountId);
    expect(await store.get(accountId)).toBeUndefined();
  });
});
