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
      .select(['m.id', 'm.embedding_hash'])
      .where('m.account_id', '=', accountId)
      .where((eb) =>
        eb.or([
          eb('m.embedding', 'is', null),
          eb('m.embedding_model', '<>', model),
          eb(eb.ref('m.updated_at'), '>', eb.ref('m.embedded_at')),
        ]),
      )
      .orderBy('m.internal_date', 'desc')
      .limit(clamp(limit, 1, 1000))
      .execute();
    return rows.map((r) => ({ messageId: r.id, contentHash: r.embedding_hash ?? undefined }));
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
    // Not updated_at: it marks content changes, which is what makes an embedding stale.
    // Messages deleted meanwhile are skipped.
    for (const batch of chunk(items, 100)) {
      const values = sql.join(
        batch.map(
          (i) => sql`(${i.messageId}, ${i.model}, ${i.contentHash}, ${toVector(i.embedding)})`,
        ),
      );
      await sql`
        update messages m set
          embedding = v.embedding::vector,
          embedding_model = v.model,
          embedding_hash = v.content_hash,
          embedded_at = now()
        from (values ${values}) as v (id, model, content_hash, embedding)
        where m.account_id = ${accountId} and m.id = v.id`.execute(this.db);
    }
  }

  async touch(accountId: string, messageIds: string[]) {
    if (messageIds.length === 0) return;
    await this.db
      .updateTable('messages')
      .set({ embedded_at: sql`now()` })
      .where('account_id', '=', accountId)
      .where('id', 'in', messageIds)
      .where('embedding', 'is not', null)
      .execute();
  }

  async search(accountId: string, embedding: number[], filter: MessageFilter, limit: number) {
    const vector = toVector(embedding);
    return this.db.transaction().execute(async (trx) => {
      // With filters, keep walking the HNSW graph until enough rows pass (pgvector >= 0.8).
      await sql`set local hnsw.iterative_scan = relaxed_order`.execute(trx);
      await sql`set local hnsw.ef_search = 100`.execute(trx);
      const rows = await trx
        .selectFrom('messages as m')
        .select(['m.id', sql<number>`m.embedding <=> ${vector}::vector`.as('distance')])
        .where('m.account_id', '=', accountId)
        .where('m.embedding', 'is not', null)
        .where((eb) => messageFilter(eb, filter))
        .orderBy(sql`m.embedding <=> ${vector}::vector`)
        .limit(clamp(limit, 1, 500))
        .execute();
      // relaxed_order may return slightly out-of-order rows; sort precisely.
      return rows
        .map((r) => ({ messageId: r.id, score: 1 - Number(r.distance) }))
        .sort((a, b) => b.score - a.score);
    });
  }

  async stats(accountId: string, model: string) {
    const row = await this.db
      .selectFrom('messages as m')
      .select([
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) filter (where m.embedding_model = ${model})`.as('indexed'),
      ])
      .where('m.account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    return { indexed: Number(row.indexed), total: Number(row.total) };
  }
}
