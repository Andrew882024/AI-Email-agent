import { type Selectable, sql } from 'kysely';
import type { Label } from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { LabelRepository } from '../repositories.js';
import type { LabelsTable } from '../schema.js';

function toLabel(row: Selectable<LabelsTable>): Label {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ...(row.color_background !== null &&
      row.color_text !== null && {
        color: { background: row.color_background, text: row.color_text },
      }),
  };
}

async function upsertLabels(db: Db, accountId: string, labels: Label[]): Promise<void> {
  if (labels.length === 0) return;
  await db
    .insertInto('labels')
    .values(
      labels.map((l) => ({
        account_id: accountId,
        id: l.id,
        name: l.name,
        type: l.type,
        color_background: l.color?.background ?? null,
        color_text: l.color?.text ?? null,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['account_id', 'id']).doUpdateSet((eb) => ({
        name: eb.ref('excluded.name'),
        type: eb.ref('excluded.type'),
        color_background: eb.ref('excluded.color_background'),
        color_text: eb.ref('excluded.color_text'),
      })),
    )
    .execute();
}

export class PgLabelRepository implements LabelRepository {
  constructor(private readonly db: Db) {}

  async list(accountId: string) {
    const rows = await this.db
      .selectFrom('labels')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('type')
      .orderBy('name')
      .execute();
    return rows.map(toLabel);
  }

  async get(accountId: string, id: string) {
    const row = await this.db
      .selectFrom('labels')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toLabel(row);
  }

  async findByName(accountId: string, name: string) {
    const row = await this.db
      .selectFrom('labels')
      .selectAll()
      .where('account_id', '=', accountId)
      .where(sql<string>`lower(name)`, '=', name.toLowerCase())
      .executeTakeFirst();
    return row && toLabel(row);
  }

  async upsert(accountId: string, labels: Label[]) {
    await upsertLabels(this.db, accountId, labels);
  }

  async replaceAll(accountId: string, labels: Label[]) {
    await this.db.transaction().execute(async (trx) => {
      await upsertLabels(trx, accountId, labels);
      const keep = labels.map((l) => l.id);
      let stale = trx.deleteFrom('labels').where('account_id', '=', accountId);
      if (keep.length > 0) stale = stale.where('id', 'not in', keep);
      const removed = await stale.returning('id').execute();
      if (removed.length > 0) {
        await trx
          .deleteFrom('message_labels')
          .where('account_id', '=', accountId)
          .where(
            'label_id',
            'in',
            removed.map((r) => r.id),
          )
          .execute();
      }
    });
  }

  async delete(accountId: string, id: string) {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('message_labels')
        .where('account_id', '=', accountId)
        .where('label_id', '=', id)
        .execute();
      await trx
        .deleteFrom('labels')
        .where('account_id', '=', accountId)
        .where('id', '=', id)
        .execute();
    });
  }
}
