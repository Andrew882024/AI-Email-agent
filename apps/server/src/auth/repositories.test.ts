import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../shared/testing/db.js';
import { PgAccountRepository } from './account-repository.js';
import { PgOAuthTokenRepository } from './oauth-token-repository.js';

describe.skipIf(!testDatabaseUrl)('auth repositories', () => {
  let t: TestDatabase;
  let accounts: PgAccountRepository;
  let tokens: PgOAuthTokenRepository;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    accounts = new PgAccountRepository(t.db);
    tokens = new PgOAuthTokenRepository(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    accountId = (await accounts.upsert({ email: 'me@example.com', googleSub: 'sub-1' })).id;
  });

  describe('accounts', () => {
    it('upserts by googleSub, lists and deletes', async () => {
      const again = await accounts.upsert({
        email: 'new@example.com',
        googleSub: 'sub-1',
        displayName: 'Me',
      });
      expect(again).toMatchObject({ id: accountId, email: 'new@example.com', displayName: 'Me' });

      expect(await accounts.list()).toHaveLength(1);

      await accounts.delete(accountId);
      expect(await accounts.getById(accountId)).toBeUndefined();
    });
  });

  describe('oauth tokens', () => {
    it('saves, replaces and deletes; cascades with the account', async () => {
      expect(await tokens.get(accountId)).toBeUndefined();
      await tokens.save(accountId, { encryptedRefreshToken: 'c1', scopes: ['a'] });
      await tokens.save(accountId, { encryptedRefreshToken: 'c2', scopes: ['a', 'b'] });
      expect(await tokens.get(accountId)).toMatchObject({
        accountId,
        encryptedRefreshToken: 'c2',
        scopes: ['a', 'b'],
      });
      await tokens.delete(accountId);
      expect(await tokens.get(accountId)).toBeUndefined();

      await tokens.save(accountId, { encryptedRefreshToken: 'c3', scopes: [] });
      await accounts.delete(accountId);
      expect(await tokens.get(accountId)).toBeUndefined();
    });
  });
});
