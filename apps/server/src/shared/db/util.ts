export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Escape LIKE/ILIKE wildcards (Postgres default escape char is backslash). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string, length: number): string[] {
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw new Error('Invalid cursor');
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== length ||
    !parts.every((p) => typeof p === 'string')
  )
    throw new Error('Invalid cursor');
  return parts;
}
