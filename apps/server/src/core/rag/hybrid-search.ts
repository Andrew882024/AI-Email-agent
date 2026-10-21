import type { MessageFilter, Repositories, SearchHit } from '../db/repositories.js';
import type { MessageSummary } from '../domain/types.js';
import type { EmbeddingProvider } from '../llm/types.js';
import type { Logger } from '../logging/system-logger.js';

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface SearchResultItem extends MessageSummary {
  /** Reciprocal-rank-fusion score; only meaningful for ordering. */
  score: number;
  /** Which retrievers found it. */
  matchedBy: ('keyword' | 'semantic')[];
  /** Cosine similarity to the query, when found semantically. */
  similarity?: number;
}

export interface SearchResult {
  items: SearchResultItem[];
  /** The mode actually used (semantic parts are skipped when embeddings are unavailable). */
  mode: SearchMode;
  /** Why semantic search was skipped, if it was. */
  note?: string;
}

/** Standard RRF constant: dampens the weight of top ranks so both lists contribute. */
const RRF_K = 60;

/**
 * Keyword (full-text + substring) and semantic (vector) retrieval fused with Reciprocal Rank
 * Fusion. Falls back to keyword-only when no embedding provider is configured or it fails.
 */
export class HybridSearch {
  constructor(
    private readonly options: {
      repos: Repositories;
      embeddings?: EmbeddingProvider;
      logger?: Logger;
    },
  ) {}

  async search(
    accountId: string,
    query: string,
    filter: MessageFilter = {},
    limit = 20,
    mode: SearchMode = 'hybrid',
  ): Promise<SearchResult> {
    const { repos, embeddings } = this.options;
    const depth = Math.max(limit * 3, 50);
    let used = mode;
    let note: string | undefined;

    let semantic: SearchHit[] = [];
    if (mode !== 'keyword') {
      if (!embeddings) {
        used = 'keyword';
        note = 'Semantic search is not configured (no embedding provider)';
      } else {
        try {
          const [vector] = await embeddings.embed([query], 'query');
          semantic = await repos.vectors.search(accountId, vector!, filter, depth);
        } catch (err) {
          this.options.logger?.warn({ err }, 'semantic search failed; using keyword search');
          used = 'keyword';
          note = `Semantic search unavailable: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    const keyword =
      used !== 'semantic'
        ? await repos.messages.keywordSearch(accountId, query, filter, depth)
        : [];

    const fused = new Map<
      string,
      { score: number; matchedBy: SearchResultItem['matchedBy']; similarity?: number }
    >();
    const add = (hits: SearchHit[], source: 'keyword' | 'semantic') =>
      hits.forEach((hit, rank) => {
        const entry = fused.get(hit.messageId) ?? { score: 0, matchedBy: [] };
        entry.score += 1 / (RRF_K + rank + 1);
        entry.matchedBy.push(source);
        if (source === 'semantic') entry.similarity = hit.score;
        fused.set(hit.messageId, entry);
      });
    add(keyword, 'keyword');
    add(semantic, 'semantic');

    const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    const messages = new Map(
      (
        await repos.messages.getByIds(
          accountId,
          top.map(([id]) => id),
        )
      ).map((m) => [m.id, m]),
    );
    const items = top.flatMap(([id, hit]) => {
      const m = messages.get(id);
      if (!m) return [];
      const summary: MessageSummary = {
        id: m.id,
        threadId: m.threadId,
        from: m.from,
        to: m.to,
        subject: m.subject,
        snippet: m.snippet,
        internalDate: m.internalDate,
        hasAttachments: m.hasAttachments,
        labelIds: m.labelIds,
        isRead: m.isRead,
        isStarred: m.isStarred,
        inInbox: m.inInbox,
      };
      return [{ ...summary, ...hit }];
    });
    return { items, mode: used, ...(note && { note }) };
  }
}
