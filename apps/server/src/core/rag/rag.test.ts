import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from '../../../test/helpers/db.js';
import { FakeEmbeddings } from '../../../test/helpers/fake-llm.js';
import { createPgRepositories } from '../db/pg/index.js';
import type { Repositories } from '../db/repositories.js';
import type { MessageUpsert } from '../domain/types.js';
import { type AppEvents, EventBus } from '../events/event-bus.js';
import { HybridSearch } from './hybrid-search.js';
import { EmailIndexer } from './indexer.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
const message = (
  id: string,
  subject: string,
  body: string,
  over: Partial<MessageUpsert> = {},
): MessageUpsert => ({
  id,
  threadId: `t-${id}`,
  from: { name: 'Sender', email: 'sender@example.com' },
  to: [{ email: 'me@example.com' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject,
  snippet: body.slice(0, 40),
  bodyText: body,
  internalDate: at(Number(id.replace(/\D/g, '')) || 0),
  hasAttachments: false,
  labelIds: ['INBOX'],
  attachments: [],
  ...over,
});

describe.skipIf(!testDatabaseUrl)('semantic index', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let accountId: string;
  let embeddings: FakeEmbeddings;
  let events: EventBus;
  let statuses: AppEvents['index.status'][];
  const logger = pino({ level: 'silent' });
  const indexer = (batchSize = 50) =>
    new EmailIndexer({ repos, embeddings, events, logger, batchSize });

  beforeAll(async () => {
    t = await createTestDatabase();
    repos = createPgRepositories(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    accountId = (await repos.accounts.upsert({ email: 'me@example.com', googleSub: 's' })).id;
    embeddings = new FakeEmbeddings();
    events = new EventBus(logger);
    statuses = [];
    events.on('index.status', (s) => void statuses.push(s));
    await repos.messages.upsertMany(accountId, [
      message(
        'm1',
        'Flight confirmation',
        'Your flight to Tokyo departs Friday at 9am. Boarding pass attached.',
      ),
      message('m2', 'Invoice 4521', 'Invoice 4521 for cloud hosting is due. Amount 40 dollars.'),
      message('m3', 'Team lunch', 'Lunch on Friday at the noodle place downtown.'),
      message('m4', '发票通知', '本月发票已开具，请查收。', { labelIds: [] }),
    ]);
  });

  describe('EmailIndexer', () => {
    it('embeds every message in batches and reports progress', async () => {
      expect(await indexer(3).indexAll(accountId)).toEqual({ embedded: 4 });
      expect(embeddings.calls.map((c) => [c.texts.length, c.task])).toEqual([
        [3, 'document'],
        [1, 'document'],
      ]);
      // Batches are picked newest first (m4 is the newest), so recent mail is searchable soonest.
      expect(embeddings.calls[0]!.texts).toContainEqual(
        expect.stringMatching(/^Subject: 发票通知\nFrom: Sender <sender@example\.com>/),
      );
      expect(await repos.vectors.stats(accountId, 'fake-embed')).toEqual({ indexed: 4, total: 4 });
      expect(statuses.at(-1)).toEqual({ accountId, phase: 'idle', indexed: 4, total: 4 });
      expect(await indexer().indexAll(accountId)).toEqual({ embedded: 0 });
    });

    it('skips label-only changes and re-embeds changed content', async () => {
      await indexer().indexAll(accountId);
      embeddings.calls.length = 0;
      await new Promise((r) => setTimeout(r, 5));
      // Re-sync with new labels only (e.g. read/archived): same text, no API call.
      await repos.messages.upsertMany(accountId, [
        message(
          'm1',
          'Flight confirmation',
          'Your flight to Tokyo departs Friday at 9am. Boarding pass attached.',
          { labelIds: [] },
        ),
      ]);
      expect(await indexer().indexAll(accountId)).toEqual({ embedded: 0 });
      expect(embeddings.calls).toEqual([]);
      expect(await repos.vectors.stale(accountId, 'fake-embed', 10)).toEqual([]);

      await new Promise((r) => setTimeout(r, 5));
      await repos.messages.upsertMany(accountId, [
        message('m2', 'Invoice 4521 (corrected)', 'Corrected amount: 45 dollars.'),
      ]);
      expect(await indexer().indexAll(accountId)).toEqual({ embedded: 1 });
      expect(embeddings.calls[0]!.texts[0]).toContain('corrected');
    });

    it('re-embeds everything when the model changes', async () => {
      await indexer().indexAll(accountId);
      embeddings = new FakeEmbeddings('fake-embed-v2');
      expect(await indexer().indexAll(accountId)).toEqual({ embedded: 4 });
    });
  });

  describe('HybridSearch', () => {
    beforeEach(async () => {
      await indexer().indexAll(accountId);
    });
    const search = (query: string, filter = {}, mode?: 'hybrid' | 'keyword' | 'semantic') =>
      new HybridSearch({ repos, embeddings }).search(accountId, query, filter, 3, mode);

    it('ranks messages found by both retrievers first and says how each was found', async () => {
      const result = await search('invoice due');
      expect(result.mode).toBe('hybrid');
      expect(result.items[0]).toMatchObject({
        id: 'm2',
        subject: 'Invoice 4521',
        matchedBy: ['keyword', 'semantic'],
      });
      expect(result.items[0]!.similarity).toBeGreaterThan(0);
      expect(result.items[0]).not.toHaveProperty('bodyText');
    });

    it('finds meaning without exact keywords (semantic only)', async () => {
      // "Friday" appears in two emails; "boarding pass Tokyo" only in the flight one.
      const { items } = await search('Tokyo boarding pass', {}, 'semantic');
      expect(items[0]!.id).toBe('m1');
      expect(items.every((i) => i.matchedBy.join() === 'semantic')).toBe(true);
    });

    it('applies filters to both retrievers', async () => {
      const { items } = await search('发票 invoice', { labelIds: ['INBOX'] });
      expect(items.map((i) => i.id)).not.toContain('m4');
      expect((await search('发票')).items[0]!.id).toBe('m4');
    });

    it('falls back to keyword search when embeddings fail or are not configured', async () => {
      embeddings.failWith = new Error('quota exceeded');
      const failed = await search('invoice');
      expect(failed).toMatchObject({
        mode: 'keyword',
        note: expect.stringContaining('quota exceeded'),
      });
      expect(failed.items.map((i) => i.id)).toEqual(['m2']);
      const none = await new HybridSearch({ repos }).search(accountId, 'invoice');
      expect(none.mode).toBe('keyword');
    });
  });
});
