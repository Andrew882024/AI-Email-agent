import { EMBEDDING_DIMENSIONS } from '../../src/core/db/pg/index.js';
import type {
  EmbeddingProvider,
  EmbeddingTask,
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  Part,
  StreamChunk,
} from '../../src/core/llm/types.js';

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

/** A model whose answers are scripted per request: return text, or parts (e.g. tool calls). */
export class ScriptedLLM implements LLMProvider {
  readonly model = 'scripted';
  readonly requests: { kind: 'stream' | 'generate'; request: GenerateRequest }[] = [];

  constructor(
    private readonly respond: (
      request: GenerateRequest,
      kind: 'stream' | 'generate',
    ) => string | Part[],
  ) {}

  private answer(request: GenerateRequest, kind: 'stream' | 'generate'): GenerateResult {
    this.requests.push({ kind, request });
    const out = this.respond(request, kind);
    const parts: Part[] = typeof out === 'string' ? [{ type: 'text', text: out }] : out;
    return {
      parts,
      text: parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
      toolCalls: parts.filter(
        (p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call',
      ),
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return this.answer(request, 'generate');
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const result = this.answer(request, 'stream');
    for (const part of result.parts) {
      if (part.type === 'text') {
        // Arrive in two chunks, like a real stream.
        const half = Math.ceil(part.text.length / 2);
        yield { type: 'text', text: part.text.slice(0, half) };
        if (part.text.length > half) yield { type: 'text', text: part.text.slice(half) };
      }
      if (part.type === 'tool_call') yield { type: 'tool_call', call: part };
    }
    yield { type: 'done', result };
  }

  /** Requests of one kind, e.g. the agent's turns ('stream'). */
  of(kind: 'stream' | 'generate'): GenerateRequest[] {
    return this.requests.filter((r) => r.kind === kind).map((r) => r.request);
  }
}
