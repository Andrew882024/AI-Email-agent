import { type Selectable, sql } from 'kysely';
import type { Account } from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { AccountRepository } from '../repositories.js';
import type { AccountsTable } from '../schema.js';

function toAccount(row: Selectable<AccountsTable>): Account {
  return {
    id: row.id,
    email: row.email,
    googleSub: row.google_sub,
    displayName: row.display_name ?? undefined,
    historyId: row.history_id ?? undefined,
    lastFullSyncAt: row.last_full_sync_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgAccountRepository implements AccountRepository {
  constructor(private readonly db: Db) {}

  async upsert(input: { email: string; googleSub: string; displayName?: string }) {
    const displayName = input.displayName ?? null;
    const row = await this.db
      .insertInto('accounts')
      .values({ email: input.email, google_sub: input.googleSub, display_name: displayName })
      .onConflict((oc) =>
        oc.column('google_sub').doUpdateSet({
          email: input.email,
          display_name: displayName,
          updated_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAccount(row);
  }

  async getById(id: string) {
    const row = await this.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toAccount(row);
  }

  async list() {
    const rows = await this.db.selectFrom('accounts').selectAll().orderBy('created_at').execute();
    return rows.map(toAccount);
  }

  async updateSyncState(id: string, state: { historyId?: string; lastFullSyncAt?: Date }) {
    await this.db
      .updateTable('accounts')
      .set({
        ...(state.historyId !== undefined && { history_id: state.historyId }),
        ...(state.lastFullSyncAt !== undefined && { last_full_sync_at: state.lastFullSyncAt }),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string) {
    await this.db.deleteFrom('accounts').where('id', '=', id).execute();
  }
}
