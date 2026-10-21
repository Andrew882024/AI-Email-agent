import { z } from 'zod';
import { type GenerateRequest, type LLMProvider, LLMOutputError } from './types.js';

/** Ask for JSON matching a zod schema and return it validated. */
export async function generateObject<S extends z.ZodType>(
  llm: LLMProvider,
  request: Omit<GenerateRequest, 'responseSchema' | 'tools'>,
  schema: S,
): Promise<z.output<S>> {
  const result = await llm.generate({
    ...request,
    responseSchema: z.toJSONSchema(schema, { io: 'input' }),
  });
  let json: unknown;
  try {
    json = JSON.parse(result.text);
  } catch {
    throw new LLMOutputError(`Model output is not JSON: ${result.text.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new LLMOutputError(
      `Model output does not match the schema: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}
