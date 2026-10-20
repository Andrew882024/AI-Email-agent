import {
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part as GeminiPart,
} from '@google/genai';
import { type RetryOptions, withRetry } from '../google/retry.js';
import {
  type ChatMessage,
  type EmbeddingProvider,
  type EmbeddingTask,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  LLMOutputError,
  type Part,
  type StreamChunk,
} from './types.js';

/** zod's JSON Schema output names its dialect; Gemini's schema parser doesn't accept that key. */
export function toGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const rest = { ...(schema as Record<string, unknown>) };
  delete rest.$schema;
  return rest;
}

export function toGeminiContents(messages: ChatMessage[]): Content[] {
  return messages.map((message) => ({
    role: message.role,
    parts: message.parts.map((part): GeminiPart => {
      switch (part.type) {
        case 'text':
          return { text: part.text, ...(part.signature && { thoughtSignature: part.signature }) };
        case 'file':
          return {
            inlineData: {
              mimeType: part.mimeType,
              data: part.data.toString('base64'),
              displayName: part.name,
            },
          };
        case 'tool_call':
          return {
            functionCall: { id: part.id, name: part.name, args: part.args },
            ...(part.signature && { thoughtSignature: part.signature }),
          };
        case 'tool_result': {
          // Gemini wants an object; wrap anything else.
          const value = part.isError ? { error: part.result } : part.result;
          const response =
            value && typeof value === 'object' && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : { result: value };
          return { functionResponse: { id: part.id, name: part.name, response } };
        }
      }
    }),
  }));
}

/** Model output parts → ours. Thought summaries are dropped; signatures are kept. */
export function fromGeminiParts(parts: GeminiPart[] | undefined): Part[] {
  const out: Part[] = [];
  for (const p of parts ?? []) {
    if (p.thought) continue;
    if (p.functionCall?.name) {
      out.push({
        type: 'tool_call',
        id: p.functionCall.id,
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
        ...(p.thoughtSignature && { signature: p.thoughtSignature }),
      });
    } else if (p.text !== undefined) {
      out.push({
        type: 'text',
        text: p.text,
        ...(p.thoughtSignature && { signature: p.thoughtSignature }),
      });
    }
  }
  return out;
}

function toConfig(request: GenerateRequest): GenerateContentConfig {
  return {
    ...(request.system && { systemInstruction: request.system }),
    ...(request.tools?.length && {
      tools: [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: toGeminiSchema(t.parameters),
          })),
        },
      ],
    }),
    ...(request.responseSchema !== undefined && {
      responseMimeType: 'application/json',
      responseJsonSchema: toGeminiSchema(request.responseSchema),
    }),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxOutputTokens !== undefined && { maxOutputTokens: request.maxOutputTokens }),
    ...(request.signal && { abortSignal: request.signal }),
  };
}

export function toResult(
  parts: Part[],
  response: GenerateContentResponse | undefined,
): GenerateResult {
  const usage = response?.usageMetadata;
  return {
    parts,
    text: parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
    toolCalls: parts.filter(
      (p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call',
    ),
    finishReason: response?.candidates?.[0]?.finishReason,
    ...(usage && {
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      },
    }),
  };
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  retry?: RetryOptions;
  /** Test seam. */
  client?: GoogleGenAI;
}

export class GeminiProvider implements LLMProvider {
  readonly model: string;
  private readonly ai: GoogleGenAI;

  constructor(private readonly options: GeminiOptions) {
    this.model = options.model;
    this.ai = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await withRetry(
      () =>
        this.ai.models.generateContent({
          model: this.model,
          contents: toGeminiContents(request.messages),
          config: toConfig(request),
        }),
      this.options.retry,
    );
    const parts = fromGeminiParts(response.candidates?.[0]?.content?.parts);
    if (parts.length === 0) {
      const reason =
        response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? 'unknown';
      throw new LLMOutputError(`The model returned no content (${reason})`);
    }
    return toResult(parts, response);
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const stream = await withRetry(
      () =>
        this.ai.models.generateContentStream({
          model: this.model,
          contents: toGeminiContents(request.messages),
          config: toConfig(request),
        }),
      this.options.retry,
    );
    const parts: Part[] = [];
    let last: GenerateContentResponse | undefined;
    for await (const chunk of stream) {
      last = chunk;
      for (const part of fromGeminiParts(chunk.candidates?.[0]?.content?.parts)) {
        const previous = parts.at(-1);
        if (part.type === 'text' && previous?.type === 'text' && !part.signature) {
          previous.text += part.text; // merge deltas into one part
        } else {
          parts.push(part.type === 'text' ? { ...part } : part);
        }
        if (part.type === 'text' && part.text) yield { type: 'text', text: part.text };
        if (part.type === 'tool_call') yield { type: 'tool_call', call: part };
      }
    }
    yield { type: 'done', result: toResult(parts, last) };
  }
}

const TASK_TYPES: Record<EmbeddingTask, string> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
};

export class GeminiEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly ai: GoogleGenAI;

  constructor(
    private readonly options: GeminiOptions & { dimensions: number; batchSize?: number },
  ) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.ai = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
  }

  async embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    const out: number[][] = [];
    const size = this.options.batchSize ?? 50;
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const response = await withRetry(
        () =>
          this.ai.models.embedContent({
            model: this.model,
            // One Content per text: gemini-embedding-2 merges a plain string[] into a single
            // multimodal input and returns one embedding for the whole batch.
            contents: batch.map((text) => ({ parts: [{ text }] })),
            config: {
              taskType: TASK_TYPES[task],
              outputDimensionality: this.dimensions,
            },
          }),
        this.options.retry,
      );
      const vectors = response.embeddings?.map((e) => e.values ?? []) ?? [];
      if (vectors.length !== batch.length || vectors.some((v) => v.length !== this.dimensions)) {
        throw new LLMOutputError(`Embedding response shape mismatch for ${batch.length} texts`);
      }
      // Reduced-dimension Gemini embeddings aren't unit length; normalize for cosine/dot search.
      out.push(...vectors.map(normalize));
    }
    return out;
  }
}

export function normalize(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((x) => x / norm);
}
