import type { Repositories } from '../db/repositories.js';
import type { EventBus } from '../events/event-bus.js';
import type { EmbeddingProvider } from '../llm/types.js';
import type { Logger } from '../logging/system-logger.js';
import { contentHash, emailChunk } from './chunk.js';

export interface EmailIndexerOptions {
  repos: Repositories;
  embeddings: EmbeddingProvider;
  events: EventBus;
  logger: Logger;
  /** Messages per embedding request. */
  batchSize?: number;
}

/**
 * Keeps the vector index in step with the mailbox. Its only state is the data itself (which
 * messages lack a current embedding), so it resumes after restarts and needs no job queue.
 */
export class EmailIndexer {
  constructor(private readonly options: EmailIndexerOptions) {}

  get model(): string {
    return this.options.embeddings.model;
  }

  /** Embed one batch of stale messages. `remaining` tells whether more are waiting. */
  async indexBatch(
    accountId: string,
  ): Promise<{ embedded: number; unchanged: number; remaining: boolean }> {
    const { repos, embeddings } = this.options;
    const size = this.options.batchSize ?? 50;
    const stale = await repos.vectors.stale(accountId, embeddings.model, size);
    if (stale.length === 0) return { embedded: 0, unchanged: 0, remaining: false };

    const storedHash = new Map(stale.map((s) => [s.messageId, s.contentHash]));
    const messages = await repos.messages.getByIds(accountId, [...storedHash.keys()]);
    const chunks = messages.map((m) => {
      const text = emailChunk(m);
      return { messageId: m.id, text, hash: contentHash(embeddings.model, text) };
    });
    // Label/flag changes bump updated_at without changing the text: no need to re-embed.
    const unchanged = chunks.filter((c) => storedHash.get(c.messageId) === c.hash);
    const changed = chunks.filter((c) => storedHash.get(c.messageId) !== c.hash);
    await repos.vectors.touch(
      accountId,
      unchanged.map((c) => c.messageId),
    );
    if (changed.length > 0) {
      const vectors = await embeddings.embed(
        changed.map((c) => c.text),
        'document',
      );
      await repos.vectors.upsert(
        accountId,
        changed.map((c, i) => ({
          messageId: c.messageId,
          model: embeddings.model,
          contentHash: c.hash,
          embedding: vectors[i]!,
        })),
      );
    }
    return {
      embedded: changed.length,
      unchanged: unchanged.length,
      remaining: stale.length === size,
    };
  }

  /** Index everything that's stale, reporting progress. */
  async indexAll(accountId: string): Promise<{ embedded: number }> {
    const { repos, events } = this.options;
    let embedded = 0;
    let remaining = true;
    let announced = false;
    while (remaining) {
      const batch = await this.indexBatch(accountId);
      embedded += batch.embedded;
      remaining = batch.remaining;
      if (batch.embedded + batch.unchanged === 0) break;
      if (batch.embedded > 0 || announced) {
        announced = true;
        const stats = await repos.vectors.stats(accountId, this.model);
        events.emit('index.status', {
          accountId,
          phase: remaining ? 'indexing' : 'idle',
          ...stats,
        });
      }
    }
    if (embedded > 0) this.options.logger.info({ accountId, embedded }, 'indexed messages');
    return { embedded };
  }
}
