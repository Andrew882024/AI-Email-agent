import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  fromGeminiParts,
  GeminiEmbeddings,
  normalize,
  toGeminiContents,
  toGeminiSchema,
} from './gemini.js';
import { generateObject } from './structured.js';
import { type GenerateRequest, type LLMProvider, LLMOutputError } from './types.js';

describe('Gemini mapping', () => {
  it('maps every part type, keeping tool-call signatures', () => {
    const contents = toGeminiContents([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'hi' },
          { type: 'file', mimeType: 'image/png', data: Buffer.from('png'), name: 'a.png' },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            type: 'tool_call',
            id: 'c1',
            name: 'star',
            args: { messageIds: ['m1'] },
            signature: 'sig',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { type: 'tool_result', id: 'c1', name: 'star', result: { updated: 1 } },
          { type: 'tool_result', name: 'list', result: [1, 2] },
          { type: 'tool_result', name: 'x', result: 'boom', isError: true },
        ],
      },
    ]);
    expect(contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'hi' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: Buffer.from('png').toString('base64'),
              displayName: 'a.png',
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'c1', name: 'star', args: { messageIds: ['m1'] } },
            thoughtSignature: 'sig',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'c1', name: 'star', response: { updated: 1 } } },
          { functionResponse: { id: undefined, name: 'list', response: { result: [1, 2] } } },
          { functionResponse: { id: undefined, name: 'x', response: { error: 'boom' } } },
        ],
      },
    ]);
  });

  it('reads model output, dropping thoughts', () => {
    expect(
      fromGeminiParts([
        { text: 'thinking…', thought: true },
        { text: 'Answer', thoughtSignature: 's1' },
        {
          functionCall: { id: 'c', name: 'search_emails', args: { query: 'q' } },
          thoughtSignature: 's2',
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'Answer', signature: 's1' },
      { type: 'tool_call', id: 'c', name: 'search_emails', args: { query: 'q' }, signature: 's2' },
    ]);
  });

  it('strips the JSON Schema dialect key and normalizes vectors', () => {
    expect(toGeminiSchema({ $schema: 'x', type: 'object' })).toEqual({ type: 'object' });
    expect(normalize([3, 4])).toEqual([0.6, 0.8]);
  });
});

describe('GeminiEmbeddings', () => {
  it('sends one Content per text (a string[] would be merged into one embedding) and normalizes', async () => {
    const calls: unknown[] = [];
    const client = {
      models: {
        embedContent: async (params: { contents: unknown[] }) => {
          calls.push(params);
          return { embeddings: params.contents.map(() => ({ values: [3, 4] })) };
        },
      },
    };
    const emb = new GeminiEmbeddings({
      apiKey: 'k',
      model: 'm',
      dimensions: 2,
      batchSize: 2,
      client: client as never,
    });
    expect(await emb.embed(['a', 'b', 'c'], 'query')).toEqual([
      [0.6, 0.8],
      [0.6, 0.8],
      [0.6, 0.8],
    ]);
    expect(calls).toEqual([
      {
        model: 'm',
        contents: [{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }],
        config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 2 },
      },
      {
        model: 'm',
        contents: [{ parts: [{ text: 'c' }] }],
        config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 2 },
      },
    ]);
  });

  it('rejects a response with the wrong number of vectors', async () => {
    const client = { models: { embedContent: async () => ({ embeddings: [{ values: [1, 0] }] }) } };
    const emb = new GeminiEmbeddings({
      apiKey: 'k',
      model: 'm',
      dimensions: 2,
      client: client as never,
    });
    await expect(emb.embed(['a', 'b'], 'document')).rejects.toThrow('shape mismatch');
  });
});

describe('generateObject', () => {
  const fake = (text: string): LLMProvider & { last?: GenerateRequest } => {
    const llm: LLMProvider & { last?: GenerateRequest } = {
      model: 'fake',
      async generate(request) {
        llm.last = request;
        return { parts: [{ type: 'text', text }], text, toolCalls: [] };
      },
      async *stream() {},
    };
    return llm;
  };
  const schema = z.object({ match: z.boolean(), reason: z.string() });

  it('requests JSON for the schema and validates the answer', async () => {
    const llm = fake('{"match":true,"reason":"invoice"}');
    expect(await generateObject(llm, { messages: [] }, schema)).toEqual({
      match: true,
      reason: 'invoice',
    });
    expect(llm.last?.responseSchema).toMatchObject({
      type: 'object',
      required: ['match', 'reason'],
    });
  });

  it('rejects invalid output', async () => {
    await expect(generateObject(fake('nope'), { messages: [] }, schema)).rejects.toThrow(
      LLMOutputError,
    );
    await expect(generateObject(fake('{"match":"yes"}'), { messages: [] }, schema)).rejects.toThrow(
      /schema/,
    );
  });
});
