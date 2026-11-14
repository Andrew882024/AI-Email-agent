import {
  type Expression,
  type ExpressionBuilder,
  type Selectable,
  type SqlBool,
  sql,
} from 'kysely';
import {
  type EmailAddress,
  type Message,
  type MessageSummary,
  type MessageUpsert,
  SystemLabel,
  type ThreadSummary,
} from '../shared/types.js';
import type {
  LabelCounts,
  MessageFilter,
  MessageListQuery,
  MessageRepository,
  MailboxDb,
} from './repositories.js';
import type { Database, MessagesTable } from '../shared/db/schema.js';
import { chunk, clamp, decodeCursor, encodeCursor, escapeLike } from '../shared/db/util.js';

const SUMMARY_COLUMNS = [
  'm.id',
  'm.thread_id',
  'm.from_addr',
  'm.to_addrs',
  'm.subject',
  'm.snippet',
  'm.internal_date',
  'm.has_attachments',
  'm.label_ids',
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
  'm.attachments',
] as const;

const BATCH_SIZE = 200;

/** Distinct, sorted text[] (the database's collation orders label_ids). */
const sortedLabels = (ids: string[]) =>
  sql<string[]>`array(select distinct unnest(${ids}::text[]) order by 1)`;

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
  | 'label_ids'
>;
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
    | 'attachments'
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

function toMessage(row: FullRow): Message {
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
    attachments: row.attachments,
  };
}

function toThreadSummary(
  threadId: string,
  lastAt: Date,
  messages: MessageSummary[],
): ThreadSummary {
  const first = messages[0];
  const newest = messages.at(-1);
  const participants = new Map<string, EmailAddress>();
  for (const m of messages) {
    if (m.from && !participants.has(m.from.email.toLowerCase())) {
      participants.set(m.from.email.toLowerCase(), m.from);
    }
  }
  return {
    threadId,
    subject: first?.subject ?? '',
    snippet: newest?.snippet ?? '',
    lastMessageAt: lastAt,
    messageCount: messages.length,
    participants: [...participants.values()],
    labelIds: [...new Set(messages.flatMap((m) => m.labelIds))].sort(),
    isRead: messages.every((m) => m.isRead),
    isStarred: messages.some((m) => m.isStarred),
    inInbox: messages.some((m) => m.inInbox),
    hasAttachments: messages.some((m) => m.hasAttachments),
    messageIds: messages.map((m) => m.id),
  };
}

/** `message m has any of <ids>` (GIN-indexed array overlap). */
function hasLabel(ids: string[]) {
  return sql<boolean>`m.label_ids && ${ids}::text[]`;
}

/** Label, keyword, sender and date conditions on message `m`. */
export function messageFilter(
  eb: ExpressionBuilder<Database & { m: MessagesTable }, 'm'>,
  query: MessageFilter,
): Expression<SqlBool> {
  const conditions: Expression<SqlBool>[] = [];
  for (const labelId of new Set(query.labelIds)) conditions.push(hasLabel([labelId]));
  const excluded = query.excludeLabelIds ?? [];
  if (excluded.length > 0) conditions.push(eb.not(hasLabel(excluded)));
  const search = query.search?.trim();
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(
      eb.or([
        sql<boolean>`m.fts @@ websearch_to_tsquery('simple', ${search})`,
        // Substring fallback (trigram-indexed): the 'simple' parser does not segment CJK text.
        eb('m.subject', 'ilike', pattern),
        sql<boolean>`left(coalesce(m.body_text, ''), 20000) ilike ${pattern}`,
        sql<boolean>`m.from_addr ->> 'email' ilike ${pattern}`,
        sql<boolean>`m.from_addr ->> 'name' ilike ${pattern}`,
      ]),
    );
  }
  const from = query.from?.trim();
  if (from) {
    const pattern = `%${escapeLike(from)}%`;
    conditions.push(
      eb.or([
        sql<boolean>`m.from_addr ->> 'email' ilike ${pattern}`,
        sql<boolean>`m.from_addr ->> 'name' ilike ${pattern}`,
      ]),
    );
  }
  if (query.receivedAfter) conditions.push(eb('m.internal_date', '>=', query.receivedAfter));
  if (query.receivedBefore) conditions.push(eb('m.internal_date', '<', query.receivedBefore));
  return conditions.length > 0 ? eb.and(conditions) : sql<boolean>`true`;
}

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly db: MailboxDb) {}

  async upsertMany(accountId: string, messages: MessageUpsert[]) {
    if (messages.length === 0) return;
    const unique = [...new Map(messages.map((m) => [m.id, m])).values()];

    await this.db.transaction().execute(async (trx) => {
      for (const batch of chunk(unique, BATCH_SIZE)) {
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
              label_ids: sortedLabels(m.labelIds),
              attachments: JSON.stringify(
                [...m.attachments].sort((a, b) => (a.partId < b.partId ? -1 : 1)),
              ),
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
              label_ids: eb.ref('excluded.label_ids'),
              attachments: eb.ref('excluded.attachments'),
              updated_at: sql`now()`,
            })),
          )
          .execute();
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
      .select(FULL_COLUMNS)
      .where('m.account_id', '=', accountId)
      .where('m.id', 'in', ids)
      .execute();
    return rows.map(toMessage);
  }

  async getThread(accountId: string, threadId: string) {
    const rows = await this.db
      .selectFrom('messages as m')
      .select(FULL_COLUMNS)
      .where('m.account_id', '=', accountId)
      .where('m.thread_id', '=', threadId)
      .orderBy('m.internal_date')
      .orderBy('m.id')
      .execute();
    return rows.map(toMessage);
  }

  async list(accountId: string, query: MessageListQuery) {
    const limit = clamp(query.limit, 1, 200);
    let q = this.db
      .selectFrom('messages as m')
      .select(SUMMARY_COLUMNS)
      .where('m.account_id', '=', accountId)
      .where((eb) => messageFilter(eb, query));

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

  async listThreads(accountId: string, query: MessageListQuery) {
    const limit = clamp(query.limit, 1, 200);
    // Threads with at least one matching message, ordered by their newest matching message.
    const matching = this.db
      .selectFrom('messages as m')
      .select((eb) => ['m.thread_id', eb.fn.max('m.internal_date').as('last_at')])
      .where('m.account_id', '=', accountId)
      .where((eb) => messageFilter(eb, query))
      .groupBy('m.thread_id');
    let q = this.db.selectFrom(matching.as('t')).select(['t.thread_id', 't.last_at']);
    if (query.cursor) {
      const [date, id] = decodeCursor(query.cursor, 2) as [string, string];
      q = q.where((eb) =>
        eb(eb.refTuple('t.last_at', 't.thread_id'), '<', eb.tuple(new Date(date), id)),
      );
    }
    const rows = await q
      .orderBy('t.last_at', 'desc')
      .orderBy('t.thread_id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    // The summary covers the whole conversation, not just the matching messages (like Gmail).
    const messages =
      page.length === 0
        ? []
        : await this.db
            .selectFrom('messages as m')
            .select(SUMMARY_COLUMNS)
            .where('m.account_id', '=', accountId)
            .where(
              'm.thread_id',
              'in',
              page.map((r) => r.thread_id),
            )
            .orderBy('m.internal_date')
            .orderBy('m.id')
            .execute();
    const byThread = new Map<string, MessageSummary[]>();
    for (const row of messages) {
      const list = byThread.get(row.thread_id) ?? [];
      list.push(toSummary(row));
      byThread.set(row.thread_id, list);
    }
    return {
      items: page.map((r) =>
        toThreadSummary(r.thread_id, r.last_at, byThread.get(r.thread_id) ?? []),
      ),
      ...(rows.length > limit &&
        last && { nextCursor: encodeCursor([last.last_at.toISOString(), last.thread_id]) }),
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

    // Remove first, then add (a label in both ends up present). label_ids stays sorted and distinct.
    // updated_at is left alone: it marks content refreshed from Gmail (resync sweep, re-embedding).
    await this.db.transaction().execute(async (trx) => {
      for (const ids of chunk([...new Set(messageIds)], BATCH_SIZE)) {
        await trx
          .updateTable('messages as m')
          .set({
            label_ids: sql<string[]>`array(
              select l from unnest(m.label_ids) l where l <> all(${remove}::text[])
              union
              select unnest(${add}::text[])
              order by 1
            )`,
          })
          .where('m.account_id', '=', accountId)
          .where('m.id', 'in', ids)
          .execute();
      }
    });
  }

  async deleteMany(accountId: string, ids: string[]) {
    if (ids.length === 0) return;
    await this.db.transaction().execute(async (trx) => {
      for (const batch of chunk([...new Set(ids)], BATCH_SIZE)) {
        await trx
          .deleteFrom('messages')
          .where('account_id', '=', accountId)
          .where('id', 'in', batch)
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

  async keywordSearch(accountId: string, text: string, filter: MessageFilter, limit: number) {
    const search = text.trim();
    if (!search) return [];
    const rows = await this.db
      .selectFrom('messages as m')
      .select([
        'm.id',
        sql<number>`ts_rank_cd(m.fts, websearch_to_tsquery('simple', ${search}))`.as('rank'),
      ])
      .where('m.account_id', '=', accountId)
      .where((eb) => messageFilter(eb, { ...filter, search }))
      .orderBy('rank', 'desc')
      .orderBy('m.internal_date', 'desc')
      .limit(clamp(limit, 1, 500))
      .execute();
    return rows.map((r) => ({ messageId: r.id, score: Number(r.rank) }));
  }

  async countByLabel(accountId: string) {
    const { rows } = await sql<{ label_id: string; total: string; unread: string }>`
      select l as label_id, count(*) as total,
        count(*) filter (where ${SystemLabel.UNREAD} = any(m.label_ids)) as unread
      from messages m cross join lateral unnest(m.label_ids) l
      where m.account_id = ${accountId}
      group by l`.execute(this.db);
    const counts: Record<string, LabelCounts> = {};
    for (const r of rows) counts[r.label_id] = { total: Number(r.total), unread: Number(r.unread) };
    return counts;
  }
}
