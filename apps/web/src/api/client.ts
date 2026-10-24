// The only place the app talks HTTP. Stateless: every function requests, validates the response
// against a zod schema and returns it. Nothing here caches or remembers anything.
import { z } from 'zod';

/** An error from the API (`{ error: { code, message } }`), or a response that failed validation. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Optional field: the server may send null or leave it out; either becomes undefined. */
export const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value ?? undefined, schema.optional());

/** `{ ok: true }`, what most write endpoints answer. */
export const Ok = z.object({ ok: z.literal(true) });

/** An ISO date string (JSON has no dates). */
export const IsoDate = z.string();

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Throws ApiError unless the response is OK. */
export async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  const payload = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  throw new ApiError(
    res.status,
    payload?.error?.code ?? 'http_error',
    payload?.error?.message ?? res.statusText,
  );
}

/** Check `data` against `schema`; a mismatch means the server and the app disagree. */
export function validate<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiError(
      0,
      'invalid_response',
      `Unexpected response from ${what}: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

/** Request JSON and validate the answer. */
export async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init: { method?: Method; body?: unknown; signal?: AbortSignal } = {},
): Promise<z.output<S>> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  await ensureOk(res);
  return validate(schema, await res.json(), `${init.method ?? 'GET'} ${path}`);
}

/** Call a server tool (the same operations the assistant and workflows use). */
export async function callTool<S extends z.ZodType>(
  name: string,
  input: unknown,
  result: S,
): Promise<z.output<S>> {
  const { result: data } = await request(z.object({ result: z.unknown() }), `/api/tools/${name}`, {
    method: 'POST',
    body: input,
  });
  return validate(result, data, `tool ${name}`);
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

/** Read a browser File as base64 (for JSON uploads). */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
