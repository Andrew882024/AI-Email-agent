import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgAccountRepository } from '../auth/account-repository.js';
import { createTestDatabase, type TestDatabase, testDatabaseUrl } from '../shared/testing/db.js';
import { PgChatRepository } from './chat-repository.js';

describe.skipIf(!testDatabaseUrl)('agent repositories', () => {
  let t: TestDatabase;
  let chats: PgChatRepository;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    chats = new PgChatRepository(t.db);
  });
  afterAll(() => t?.destroy());

  beforeEach(async () => {
    await sql`truncate accounts cascade`.execute(t.db);
    const accounts = new PgAccountRepository(t.db);
    accountId = (await accounts.upsert({ email: 'me@example.com', googleSub: 'sub-1' })).id;
  });

  describe('chat tool runs', () => {
    it('stores runs on the message, finds them by id and resolves them concurrently', async () => {
      const session = await chats.createSession(accountId);
      const message = await chats.appendMessage(session.id, 'model', []);
      const runs = await chats.createToolRuns(session.id, message.id, [
        {
          position: 1,
          tool: 'archive',
          input: { messageIds: ['m2'] },
          status: 'awaiting_approval',
        },
        {
          position: 0,
          callId: 'c1',
          tool: 'star',
          input: { messageIds: ['m1'] },
          status: 'awaiting_approval',
        },
        { position: 2, tool: 'list_labels', input: {}, status: 'done', result: { labels: [] } },
      ]);
      expect(runs.map((r) => [r.position, r.tool, r.messageId, r.sessionId])).toEqual([
        [0, 'star', message.id, session.id],
        [1, 'archive', message.id, session.id],
        [2, 'list_labels', message.id, session.id],
      ]);
      expect(runs[2]?.resolvedAt).toBeInstanceOf(Date);
      const [star, archive] = runs;
      expect(await chats.getToolRun(star!.id)).toEqual(star);
      expect((await chats.awaitingToolRuns(session.id)).map((r) => r.tool)).toEqual([
        'star',
        'archive',
      ]);
      // Messages keep their parts only; runs don't leak into the conversation.
      expect((await chats.listMessages(session.id))[0]).not.toHaveProperty('toolRuns');

      await Promise.all([
        chats.resolveToolRun(star!.id, { status: 'done', result: { updated: 1 } }),
        chats.resolveToolRun(archive!.id, { status: 'rejected', result: null }),
      ]);
      const resolved = await chats.listToolRuns(message.id);
      expect(resolved.map((r) => [r.tool, r.status, r.result])).toEqual([
        ['star', 'done', { updated: 1 }],
        ['archive', 'rejected', undefined],
        ['list_labels', 'done', { labels: [] }],
      ]);
      expect(resolved[0]?.resolvedAt).toBeInstanceOf(Date);
      expect(await chats.awaitingToolRuns(session.id)).toEqual([]);
      expect(await chats.getToolRun('00000000-0000-0000-0000-000000000000')).toBeUndefined();
    });
  });
});
