import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './env.js';

const base = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    const config = parseConfig(base);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      logLevel: 'info',
      databaseUrl: 'postgres://ai_email:ai_email@localhost:5434/ai_email',
      serverPort: 4317,
      google: { clientId: 'id', clientSecret: 'secret' },
    });
    expect(config.geminiApiKey).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    const config = parseConfig({ ...base, GEMINI_API_KEY: '', SERVER_PORT: '' });
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.serverPort).toBe(4317);
  });

  it('coerces SERVER_PORT', () => {
    expect(parseConfig({ ...base, SERVER_PORT: '8080' }).serverPort).toBe(8080);
  });

  it('rejects missing Google credentials', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseConfig({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });
});
