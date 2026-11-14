import { type Selectable, sql } from 'kysely';
import type { Account } from '../shared/types.js';
import type { AccountRepository, AuthDb } from './repositories.js';
import type { AccountsTable } from '../shared/db/schema.js';

/** Everything but the OAuth token, which has its own repository. */
const ACCOUNT_COLUMNS = [
  'id',
  'email',
  'google_sub',
  'display_name',
  'created_at',
  'updated_at',
] as const;

type AccountRow = Pick<Selectable<AccountsTable>, (typeof ACCOUNT_COLUMNS)[number]>;

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    googleSub: row.google_sub,
    displayName: row.display_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgAccountRepository implements AccountRepository {
  constructor(private readonly db: AuthDb) {}

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
      .returning(ACCOUNT_COLUMNS)
      .executeTakeFirstOrThrow();
    return toAccount(row);
  }

  async getById(id: string) {
    const row = await this.db
      .selectFrom('accounts')
      .select(ACCOUNT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toAccount(row);
  }

  async list() {
    const rows = await this.db
      .selectFrom('accounts')
      .select(ACCOUNT_COLUMNS)
      .orderBy('created_at')
      .execute();
    return rows.map(toAccount);
  }

  async delete(id: string) {
    await this.db.deleteFrom('accounts').where('id', '=', id).execute();
  }
}
