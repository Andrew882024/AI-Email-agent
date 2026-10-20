import { parseEnv } from 'node:util';

/** Values compiled into the app (the Google OAuth desktop client; not a secret for desktop apps). */
export interface EmbeddedConfig {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/** Lives in the app's data directory; any setting here overrides the embedded defaults. */
export const USER_CONFIG_FILE = 'config.env';

export interface ServerEnv {
  /** Environment for the server process (parsed by the core config schema). */
  env: Record<string, string>;
  /** APP_SECRET_KEY from the user config, imported into the keychain on first launch. */
  importKey?: string;
}

/**
 * Environment for the server: embedded defaults, overridden by the user's config.env, with the
 * data directory pinned to the app's. The token key is never passed as an env value; the main
 * process hands it over from the keychain instead.
 */
export function buildServerEnv(input: {
  embedded: EmbeddedConfig;
  userConfigText?: string;
  dataDir: string;
}): ServerEnv {
  const user = input.userConfigText ? parseEnv(input.userConfigText) : {};
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...input.embedded, ...user })) {
    if (value) merged[key] = value;
  }
  const { APP_SECRET_KEY: importKey, ...env } = merged;
  return { env: { ...env, APP_DATA_DIR: input.dataDir, NODE_ENV: 'production' }, importKey };
}
