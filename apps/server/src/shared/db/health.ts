import pg from 'pg';

export interface DatabaseHealth {
  ok: boolean;
  serverVersion?: string;
  pgvectorAvailable?: boolean;
  error?: string;
  /** Human-readable next step when the check fails. */
  hint?: string;
}

/** Connect once, verify the server responds and that the pgvector extension is installable. */
export async function checkDatabase(
  databaseUrl: string,
  timeoutMs = 3000,
): Promise<DatabaseHealth> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await client.connect();
    const version = await client.query<{ server_version: string }>('SHOW server_version');
    const vector = await client.query(
      "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'",
    );
    const pgvectorAvailable = vector.rowCount === 1;
    return {
      ok: pgvectorAvailable,
      serverVersion: version.rows[0]?.server_version,
      pgvectorAvailable,
      ...(pgvectorAvailable
        ? {}
        : {
            error: 'pgvector extension is not available on this server',
            hint: 'Use the pgvector/pgvector image from docker-compose.yml (`pnpm db:up`).',
          }),
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err), hint: hintFor(err) };
  } finally {
    await client.end().catch(() => {});
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) return errorMessage(err.errors[0]);
  return err instanceof Error ? err.message : String(err);
}

function hintFor(err: unknown): string {
  const code = (err as { code?: string }).code;
  switch (code) {
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
      return 'Postgres is not reachable. Start Docker Desktop, then run `pnpm db:up`.';
    case '28P01':
      return 'Authentication failed. Check the user/password in DATABASE_URL.';
    case '3D000':
      return 'Database does not exist. Check the database name in DATABASE_URL.';
    default:
      return 'Check DATABASE_URL and that the Postgres container is running (`docker compose ps`).';
  }
}
