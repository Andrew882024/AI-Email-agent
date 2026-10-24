import type { Db } from '../connection.js';
import type { SessionRepository, StoredSession } from '../repositories.js';

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  async create(session: { id: string; accountId: string; expiresAt: Date }) {
    await this.db
      .insertInto('sessions')
      .values({ id: session.id, account_id: session.accountId, expires_at: session.expiresAt })
      .execute();
  }

  async get(id: string): Promise<StoredSession | undefined> {
    const row = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', id)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        accountId: row.account_id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      }
    );
  }

  async touch(id: string, expiresAt: Date) {
    await this.db
      .updateTable('sessions')
      .set({ last_seen_at: new Date(), expires_at: expiresAt })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string) {
    await this.db.deleteFrom('sessions').where('id', '=', id).execute();
  }
}
