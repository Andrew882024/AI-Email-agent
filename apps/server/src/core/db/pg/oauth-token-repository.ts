import { sql } from 'kysely';
import type { Db } from '../../../shared/db/connection.js';
import type { OAuthTokenRepository, StoredOAuthToken } from '../repositories.js';

/** The account's Google refresh token, kept in columns of `accounts`. */
export class PgOAuthTokenRepository implements OAuthTokenRepository {
  constructor(private readonly db: Db) {}

  async get(accountId: string): Promise<StoredOAuthToken | undefined> {
    const row = await this.db
      .selectFrom('accounts')
      .select(['id', 'encrypted_refresh_token', 'oauth_scopes', 'oauth_updated_at'])
      .where('id', '=', accountId)
      .where('encrypted_refresh_token', 'is not', null)
      .executeTakeFirst();
    return (
      row && {
        accountId: row.id,
        encryptedRefreshToken: row.encrypted_refresh_token!,
        scopes: row.oauth_scopes,
        updatedAt: row.oauth_updated_at!,
      }
    );
  }

  async save(accountId: string, token: { encryptedRefreshToken: string; scopes: string[] }) {
    await this.db
      .updateTable('accounts')
      .set({
        encrypted_refresh_token: token.encryptedRefreshToken,
        oauth_scopes: token.scopes,
        oauth_updated_at: sql`now()`,
      })
      .where('id', '=', accountId)
      .execute();
  }

  async delete(accountId: string) {
    await this.db
      .updateTable('accounts')
      .set({ encrypted_refresh_token: null, oauth_scopes: [], oauth_updated_at: null })
      .where('id', '=', accountId)
      .execute();
  }
}
