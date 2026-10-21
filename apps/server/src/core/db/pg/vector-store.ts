import { sql } from 'kysely';
import type { Db } from '../connection.js';
import type { MessageFilter, VectorStore } from '../repositories.js';
import { messageFilter } from './message-repository.js';
import { chunk, clamp } from './util.js';

/** pgvector literal. */
const toVector = (values: number[]) => `[${values.join(',')}]`;

export class PgVectorStore implements VectorStore {
  constructor(
    private readonly db: Db,
    readonly dimensions: number,
  ) {}

  async stale(accountId: string, model: string, limit: number) {
    const rows = await this.db
      .selectFrom('messages as m')
      .leftJoin('email_embeddings as e', (join) =>
        join.onRef('e.account_id', '=', 'm.account_id').onRef('e.message_id', '=', 'm.id'),
      )
      .select(['m.id', 'e.content_hash'])
      .where('m.account_id', '=', accountId)
      .where((eb) =>
        eb.or([
          eb('e.message_id', 'is', null),
          eb('e.model', '<>', model),
          eb(eb.ref('m.updated_at'), '>', eb.ref('e.embedded_at')),
        ]),
      )
      .orderBy('m.internal_date', 'desc')
      .limit(clamp(limit, 1, 1000))
      .execute();
    return rows.map((r) => ({ messageId: r.id, contentHash: r.content_hash ?? undefined }));
  }

  async upsert(
    accountId: string,
    items: { messageId: string; model: string; contentHash: string; embedding: number[] }[],
  ) {
    for (const item of items) {
      if (item.embedding.length !== this.dimensions) {
        throw new Error(
          `Embedding has ${item.embedding.length} dimensions, expected ${this.dimensions}`,
        );
      }
    }
    for (const batch of chunk(items, 100)) {
      await this.db
        .insertInto('email_embeddings')
        .values(
          batch.map((i) => ({
            account_id: accountId,
            message_id: i.messageId,
            model: i.model,
            content_hash: i.contentHash,
            embedding: toVector(i.embedding),
          })),
        )
        .onConflict((oc) =>
          oc.columns(['account_id', 'message_id']).doUpdateSet((eb) => ({
            model: eb.ref('excluded.model'),
            content_hash: eb.ref('excluded.content_hash'),
            embedding: eb.ref('excluded.embedding'),
            embedded_at: sql`now()`,
          })),
        )
        .execute();
    }
  }

  async touch(accountId: string, messageIds: string[]) {
    if (messageIds.length === 0) return;
    await this.db
      .updateTable('email_embeddings')
      .set({ embedded_at: sql`now()` })
      .where('account_id', '=', accountId)
      .where('message_id', 'in', messageIds)
      .execute();
  }

  async search(accountId: string, embedding: number[], filter: MessageFilter, limit: number) {
    const vector = toVector(embedding);
    return this.db.transaction().execute(async (trx) => {
      // With filters, keep walking the HNSW graph until enough rows pass (pgvector >= 0.8).
      await sql`set local hnsw.iterative_scan = relaxed_order`.execute(trx);
      await sql`set local hnsw.ef_search = 100`.execute(trx);
      const rows = await trx
        .selectFrom('email_embeddings as e')
        .innerJoin('messages as m', (join) =>
          join.onRef('m.account_id', '=', 'e.account_id').onRef('m.id', '=', 'e.message_id'),
        )
        .select(['e.message_id', sql<number>`e.embedding <=> ${vector}::vector`.as('distance')])
        .where('e.account_id', '=', accountId)
        .where((eb) => messageFilter(eb, filter))
        .orderBy(sql`e.embedding <=> ${vector}::vector`)
        .limit(clamp(limit, 1, 500))
        .execute();
      // relaxed_order may return slightly out-of-order rows; sort precisely.
      return rows
        .map((r) => ({ messageId: r.message_id, score: 1 - Number(r.distance) }))
        .sort((a, b) => b.score - a.score);
    });
  }

  async stats(accountId: string, model: string) {
    const row = await this.db
      .selectFrom('messages as m')
      .leftJoin('email_embeddings as e', (join) =>
        join
          .onRef('e.account_id', '=', 'm.account_id')
          .onRef('e.message_id', '=', 'm.id')
          .on('e.model', '=', model),
      )
      .select((eb) => [
        eb.fn.countAll<string>().as('total'),
        eb.fn.count<string>('e.message_id').as('indexed'),
      ])
      .where('m.account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    return { indexed: Number(row.indexed), total: Number(row.total) };
  }
}
