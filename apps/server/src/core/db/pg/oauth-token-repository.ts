import { sql } from 'kysely';
import type { Db } from '../connection.js';
import type { OAuthTokenRepository, StoredOAuthToken } from '../repositories.js';

export class PgOAuthTokenRepository implements OAuthTokenRepository {
  constructor(private readonly db: Db) {}

  async get(accountId: string): Promise<StoredOAuthToken | undefined> {
    const row = await this.db
      .selectFrom('oauth_tokens')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return (
      row && {
        accountId: row.account_id,
        encryptedRefreshToken: row.encrypted_refresh_token,
        scopes: row.scopes,
        updatedAt: row.updated_at,
      }
    );
  }

  async save(accountId: string, token: { encryptedRefreshToken: string; scopes: string[] }) {
    await this.db
      .insertInto('oauth_tokens')
      .values({
        account_id: accountId,
        encrypted_refresh_token: token.encryptedRefreshToken,
        scopes: token.scopes,
      })
      .onConflict((oc) =>
        oc.column('account_id').doUpdateSet({
          encrypted_refresh_token: token.encryptedRefreshToken,
          scopes: token.scopes,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  async delete(accountId: string) {
    await this.db.deleteFrom('oauth_tokens').where('account_id', '=', accountId).execute();
  }
}
