import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const optionalString = z.string().min(1).optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default('postgres://ai_email:ai_email@localhost:5434/ai_email'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  APP_SECRET_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  databaseUrl: string;
  serverPort: number;
  google: { clientId: string; clientSecret: string };
  appSecretKey?: string;
  geminiApiKey?: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parse and validate an env-like record. Pure: does not read process.env or files. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  // Treat `KEY=` lines in .env as unset so defaults/optional apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    serverPort: e.SERVER_PORT,
    google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET },
    appSecretKey: e.APP_SECRET_KEY,
    geminiApiKey: e.GEMINI_API_KEY,
  };
}

/** Nearest `.env` walking up from `startDir`, or undefined. */
export function findEnvFile(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Load `.env` (if found) into process.env, then validate. Existing env vars win. */
export function loadConfig(options: { envFile?: string } = {}): AppConfig {
  const envFile = options.envFile ?? findEnvFile();
  if (envFile) process.loadEnvFile(envFile);
  return parseConfig(process.env);
}
