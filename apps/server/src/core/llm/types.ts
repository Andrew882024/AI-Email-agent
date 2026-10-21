// Provider-neutral LLM interfaces. Agent code depends only on these; llm/gemini.ts implements them.

export type Part =
  | { type: 'text'; text: string; signature?: string }
  /** Inline file the model should read: images, PDFs, ... */
  | { type: 'file'; mimeType: string; data: Buffer; name?: string }
  | {
      type: 'tool_call';
      /** Matches the tool_result that answers it. */
      id?: string;
      name: string;
      args: Record<string, unknown>;
      /** Opaque provider state that must be sent back with the call on the next turn. */
      signature?: string;
    }
  | { type: 'tool_result'; id?: string; name: string; result: unknown; isError?: boolean };

export interface LLMMessage {
  role: 'user' | 'model';
  parts: Part[];
}

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: unknown;
}

export interface GenerateRequest {
  system?: string;
  messages: LLMMessage[];
  tools?: ToolDeclaration[];
  /** Ask for JSON matching this JSON Schema (structured output). Not combined with tools. */
  responseSchema?: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  /** Text and tool_call parts, in order; append as a 'model' message to continue the conversation. */
  parts: Part[];
  text: string;
  toolCalls: Extract<Part, { type: 'tool_call' }>[];
  finishReason?: string;
  usage?: Usage;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: Extract<Part, { type: 'tool_call' }> }
  | { type: 'done'; result: GenerateResult };

export interface LLMProvider {
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
}

/** 'document' for content being indexed, 'query' for search queries (asymmetric retrieval). */
export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** One unit-length vector per text, in order. */
  embed(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

/** The model returned something we can't use (invalid JSON, schema mismatch, empty answer). */
export class LLMOutputError extends Error {
  override name = 'LLMOutputError';
}
