import { type ExpressionBuilder, type Selectable, sql } from 'kysely';
import {
  type Attachment,
  type Message,
  type MessageSummary,
  type MessageUpsert,
  SystemLabel,
} from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { LabelCounts, MessageListQuery, MessageRepository } from '../repositories.js';
import type { AttachmentsTable, Database, MessagesTable } from '../schema.js';
import { chunk, clamp, decodeCursor, encodeCursor, escapeLike } from './util.js';

const SUMMARY_COLUMNS = [
  'm.id',
  'm.thread_id',
  'm.from_addr',
  'm.to_addrs',
  'm.subject',
  'm.snippet',
  'm.internal_date',
  'm.has_attachments',
] as const;

const FULL_COLUMNS = [
  ...SUMMARY_COLUMNS,
  'm.history_id',
  'm.message_id_header',
  'm.in_reply_to',
  'm.references_header',
  'm.cc_addrs',
  'm.bcc_addrs',
  'm.reply_to_addrs',
  'm.body_text',
  'm.body_html',
  'm.size_estimate',
] as const;

const BATCH_SIZE = 200;

/** Sorted label ids of message `m`, as a selectable column. */
const labelIds = sql<string[]>`array(
  select ml.label_id from message_labels ml
  where ml.account_id = m.account_id and ml.message_id = m.id
  order by ml.label_id
)`.as('label_ids');

type SummaryRow = Pick<
  Selectable<MessagesTable>,
  | 'id'
  | 'thread_id'
  | 'from_addr'
  | 'to_addrs'
  | 'subject'
  | 'snippet'
  | 'internal_date'
  | 'has_attachments'
> & { label_ids: string[] };
type FullRow = SummaryRow &
  Pick<
    Selectable<MessagesTable>,
    | 'history_id'
    | 'message_id_header'
    | 'in_reply_to'
    | 'references_header'
    | 'cc_addrs'
    | 'bcc_addrs'
    | 'reply_to_addrs'
    | 'body_text'
    | 'body_html'
    | 'size_estimate'
  >;

function toSummary(row: SummaryRow): MessageSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    from: row.from_addr ?? undefined,
    to: row.to_addrs,
    subject: row.subject,
    snippet: row.snippet,
    internalDate: row.internal_date,
    hasAttachments: row.has_attachments,
    labelIds: row.label_ids,
    isRead: !row.label_ids.includes(SystemLabel.UNREAD),
    isStarred: row.label_ids.includes(SystemLabel.STARRED),
    inInbox: row.label_ids.includes(SystemLabel.INBOX),
  };
}

function toAttachment(row: Selectable<AttachmentsTable>): Attachment {
  return {
    partId: row.part_id,
    attachmentId: row.attachment_id ?? undefined,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    contentId: row.content_id ?? undefined,
  };
}

function toMessage(row: FullRow, attachments: Attachment[]): Message {
  return {
    ...toSummary(row),
    historyId: row.history_id ?? undefined,
    messageIdHeader: row.message_id_header ?? undefined,
    inReplyTo: row.in_reply_to ?? undefined,
    references: row.references_header ?? undefined,
    cc: row.cc_addrs,
    bcc: row.bcc_addrs,
    replyTo: row.reply_to_addrs,
    bodyText: row.body_text ?? undefined,
    bodyHtml: row.body_html ?? undefined,
    sizeEstimate: row.size_estimate ?? undefined,
    attachments,
  };
}

/** `message m has label <labelIds>` as a correlated EXISTS. */
function hasLabel(eb: ExpressionBuilder<Database & { m: MessagesTable }, 'm'>, ids: string[]) {
  return eb.exists(
    eb
      .selectFrom('message_labels as ml')
      .select('ml.label_id')
      .whereRef('ml.account_id', '=', 'm.account_id')
      .whereRef('ml.message_id', '=', 'm.id')
      .where('ml.label_id', 'in', ids),
  );
}

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly db: Db) {}

  async upsertMany(accountId: string, messages: MessageUpsert[]) {
    if (messages.length === 0) return;
    const unique = [...new Map(messages.map((m) => [m.id, m])).values()];

    await this.db.transaction().execute(async (trx) => {
      for (const batch of chunk(unique, BATCH_SIZE)) {
        const ids = batch.map((m) => m.id);

        // One row per thread (ON CONFLICT can't touch the same row twice), using its newest message.
        const newestPerThread = new Map<string, MessageUpsert>();
        for (const m of batch) {
          const current = newestPerThread.get(m.threadId);
          if (!current || m.internalDate > current.internalDate) newestPerThread.set(m.threadId, m);
        }
        await trx
          .insertInto('threads')
          .values(
            [...newestPerThread.values()].map((m) => ({
              account_id: accountId,
              id: m.threadId,
              snippet: m.snippet,
              last_message_at: m.internalDate,
            })),
          )
          .onConflict((oc) =>
            oc.columns(['account_id', 'id']).doUpdateSet({
              snippet: sql`case when excluded.last_message_at >= coalesce(threads.last_message_at, '-infinity')
                then excluded.snippet else threads.snippet end`,
              last_message_at: sql`greatest(threads.last_message_at, excluded.last_message_at)`,
            }),
          )
          .execute();

        await trx
          .insertInto('messages')
          .values(
            batch.map((m) => ({
              account_id: accountId,
              id: m.id,
              thread_id: m.threadId,
              history_id: m.historyId ?? null,
              message_id_header: m.messageIdHeader ?? null,
              in_reply_to: m.inReplyTo ?? null,
              references_header: m.references ?? null,
              from_addr: m.from ? JSON.stringify(m.from) : null,
              to_addrs: JSON.stringify(m.to),
              cc_addrs: JSON.stringify(m.cc),
              bcc_addrs: JSON.stringify(m.bcc),
              reply_to_addrs: JSON.stringify(m.replyTo),
              subject: m.subject,
              snippet: m.snippet,
              body_text: m.bodyText ?? null,
              body_html: m.bodyHtml ?? null,
              internal_date: m.internalDate,
              size_estimate: m.sizeEstimate ?? null,
              has_attachments: m.hasAttachments,
            })),
          )
          .onConflict((oc) =>
            oc.columns(['account_id', 'id']).doUpdateSet((eb) => ({
              thread_id: eb.ref('excluded.thread_id'),
              history_id: eb.ref('excluded.history_id'),
              message_id_header: eb.ref('excluded.message_id_header'),
              in_reply_to: eb.ref('excluded.in_reply_to'),
              references_header: eb.ref('excluded.references_header'),
              from_addr: eb.ref('excluded.from_addr'),
              to_addrs: eb.ref('excluded.to_addrs'),
              cc_addrs: eb.ref('excluded.cc_addrs'),
              bcc_addrs: eb.ref('excluded.bcc_addrs'),
              reply_to_addrs: eb.ref('excluded.reply_to_addrs'),
              subject: eb.ref('excluded.subject'),
              snippet: eb.ref('excluded.snippet'),
              body_text: eb.ref('excluded.body_text'),
              body_html: eb.ref('excluded.body_html'),
              internal_date: eb.ref('excluded.internal_date'),
              size_estimate: eb.ref('excluded.size_estimate'),
              has_attachments: eb.ref('excluded.has_attachments'),
              updated_at: sql`now()`,
            })),
          )
          .execute();

        await trx
          .deleteFrom('message_labels')
          .where('account_id', '=', accountId)
          .where('message_id', 'in', ids)
          .execute();
        const labelRows = batch.flatMap((m) =>
          [...new Set(m.labelIds)].map((labelId) => ({
            account_id: accountId,
            message_id: m.id,
            label_id: labelId,
          })),
        );
        for (const rows of chunk(labelRows, 1000)) {
          await trx.insertInto('message_labels').values(rows).execute();
        }

        await trx
          .deleteFrom('attachments')
          .where('account_id', '=', accountId)
          .where('message_id', 'in', ids)
          .execute();
        const attachmentRows = batch.flatMap((m) =>
          m.attachments.map((a) => ({
            account_id: accountId,
            message_id: m.id,
            part_id: a.partId,
            attachment_id: a.attachmentId ?? null,
            filename: a.filename,
            mime_type: a.mimeType,
            size: a.size,
            content_id: a.contentId ?? null,
          })),
        );
        for (const rows of chunk(attachmentRows, 500)) {
          await trx.insertInto('attachments').values(rows).execute();
        }
      }
    });
  }

  async getById(accountId: string, id: string) {
    const [message] = await this.getByIds(accountId, [id]);
    return message;
  }

  async getByIds(accountId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('messages as m')
      .select([...FULL_COLUMNS, labelIds])
      .where('m.account_id', '=', accountId)
      .where('m.id', 'in', ids)
      .execute();
    return this.withAttachments(accountId, rows);
  }

  async getThread(accountId: string, threadId: string) {
    const rows = await this.db
      .selectFrom('messages as m')
      .select([...FULL_COLUMNS, labelIds])
      .where('m.account_id', '=', accountId)
      .where('m.thread_id', '=', threadId)
      .orderBy('m.internal_date')
      .orderBy('m.id')
      .execute();
    return this.withAttachments(accountId, rows);
  }

  async list(accountId: string, query: MessageListQuery) {
    const limit = clamp(query.limit, 1, 200);
    let q = this.db
      .selectFrom('messages as m')
      .select([...SUMMARY_COLUMNS, labelIds])
      .where('m.account_id', '=', accountId);

    for (const labelId of new Set(query.labelIds)) q = q.where((eb) => hasLabel(eb, [labelId]));
    const excluded = query.excludeLabelIds ?? [];
    if (excluded.length > 0) q = q.where((eb) => eb.not(hasLabel(eb, excluded)));

    const search = query.search?.trim();
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      q = q.where((eb) =>
        eb.or([
          sql<boolean>`m.fts @@ websearch_to_tsquery('simple', ${search})`,
          // ILIKE fallback: the 'simple' parser does not segment CJK text.
          eb('m.subject', 'ilike', pattern),
          sql<boolean>`m.from_addr ->> 'email' ilike ${pattern}`,
          sql<boolean>`m.from_addr ->> 'name' ilike ${pattern}`,
        ]),
      );
    }

    if (query.cursor) {
      const [date, id] = decodeCursor(query.cursor, 2) as [string, string];
      q = q.where((eb) =>
        eb(eb.refTuple('m.internal_date', 'm.id'), '<', eb.tuple(new Date(date), id)),
      );
    }

    const rows = await q
      .orderBy('m.internal_date', 'desc')
      .orderBy('m.id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      ...(rows.length > limit &&
        last && { nextCursor: encodeCursor([last.internal_date.toISOString(), last.id]) }),
    };
  }

  async modifyLabels(
    accountId: string,
    messageIds: string[],
    change: { add?: string[]; remove?: string[] },
  ) {
    const add = [...new Set(change.add)];
    const remove = [...new Set(change.remove)];
    if (messageIds.length === 0 || (add.length === 0 && remove.length === 0)) return;

    await this.db.transaction().execute(async (trx) => {
      for (const ids of chunk([...new Set(messageIds)], BATCH_SIZE)) {
        if (remove.length > 0) {
          await trx
            .deleteFrom('message_labels')
            .where('account_id', '=', accountId)
            .where('message_id', 'in', ids)
            .where('label_id', 'in', remove)
            .execute();
        }
        if (add.length === 0) continue;
        const existing = await trx
          .selectFrom('messages')
          .select('id')
          .where('account_id', '=', accountId)
          .where('id', 'in', ids)
          .execute();
        const rows = existing.flatMap(({ id }) =>
          add.map((labelId) => ({ account_id: accountId, message_id: id, label_id: labelId })),
        );
        if (rows.length > 0) {
          await trx
            .insertInto('message_labels')
            .values(rows)
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      }
    });
  }

  async deleteMany(accountId: string, ids: string[]) {
    if (ids.length === 0) return;
    await this.db.transaction().execute(async (trx) => {
      for (const batch of chunk([...new Set(ids)], BATCH_SIZE)) {
        const deleted = await trx
          .deleteFrom('messages')
          .where('account_id', '=', accountId)
          .where('id', 'in', batch)
          .returning('thread_id')
          .execute();
        const threadIds = [...new Set(deleted.map((r) => r.thread_id))];
        if (threadIds.length === 0) continue;
        await trx
          .deleteFrom('threads as t')
          .where('t.account_id', '=', accountId)
          .where('t.id', 'in', threadIds)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom('messages as m')
                  .select('m.id')
                  .whereRef('m.account_id', '=', 't.account_id')
                  .whereRef('m.thread_id', '=', 't.id'),
              ),
            ),
          )
          .execute();
      }
    });
  }

  async sweepStale(accountId: string, options: { updatedBefore: Date; receivedSince?: Date }) {
    let q = this.db
      .selectFrom('messages')
      .select('id')
      .where('account_id', '=', accountId)
      .where('updated_at', '<', options.updatedBefore);
    if (options.receivedSince) q = q.where('internal_date', '>=', options.receivedSince);
    const ids = (await q.execute()).map((r) => r.id);
    await this.deleteMany(accountId, ids);
    return ids;
  }

  async countByLabel(accountId: string) {
    const rows = await this.db
      .selectFrom('message_labels as ml')
      .select((eb) => [
        'ml.label_id',
        eb.fn.countAll<string>().as('total'),
        sql<string>`count(*) filter (where exists (
          select 1 from message_labels u
          where u.account_id = ml.account_id and u.message_id = ml.message_id
            and u.label_id = ${SystemLabel.UNREAD}
        ))`.as('unread'),
      ])
      .where('ml.account_id', '=', accountId)
      .groupBy('ml.label_id')
      .execute();
    const counts: Record<string, LabelCounts> = {};
    for (const r of rows) counts[r.label_id] = { total: Number(r.total), unread: Number(r.unread) };
    return counts;
  }

  private async withAttachments(accountId: string, rows: FullRow[]): Promise<Message[]> {
    if (rows.length === 0) return [];
    const attachments = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('account_id', '=', accountId)
      .where(
        'message_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('part_id')
      .execute();
    const byMessage = new Map<string, Attachment[]>();
    for (const a of attachments) {
      const list = byMessage.get(a.message_id) ?? [];
      list.push(toAttachment(a));
      byMessage.set(a.message_id, list);
    }
    return rows.map((r) => toMessage(r, byMessage.get(r.id) ?? []));
  }
}
