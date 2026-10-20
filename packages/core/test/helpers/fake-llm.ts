import { EMBEDDING_DIMENSIONS } from '../../src/db/pg/index.js';
import type { EmbeddingProvider, EmbeddingTask } from '../../src/llm/types.js';

/**
 * Deterministic bag-of-words embeddings: texts sharing words are similar. Good enough to test
 * retrieval plumbing without calling an API.
 */
export class FakeEmbeddings implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly calls: { texts: string[]; task: EmbeddingTask }[] = [];
  /** Set to make the next calls fail. */
  failWith?: Error;

  constructor(readonly model = 'fake-embed') {}

  async embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    if (this.failWith) throw this.failWith;
    this.calls.push({ texts, task });
    return texts.map((text) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.codePointAt(0)!) % this.dimensions;
        v[h]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
