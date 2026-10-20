import { describe, expect, it } from 'vitest';
import { buildServerEnv } from './config';
import { allowNavigation, classifyOpen } from './navigation';
import { statusPageUrl } from './pages';
import { type KeyProtector, loadOrCreateKey } from './secret-key';

describe('buildServerEnv', () => {
  it('layers user config over embedded values and pulls the key out of the env', () => {
    const { env, importKey } = buildServerEnv({
      embedded: { GOOGLE_CLIENT_ID: 'embedded-id', GOOGLE_CLIENT_SECRET: 'embedded-secret' },
      userConfigText:
        'GOOGLE_CLIENT_ID=user-id\nGMAIL_QUOTA_UNITS_PER_MINUTE=6000\nAPP_SECRET_KEY=k\nEMPTY=\n',
      dataDir: '/data',
    });
    expect(env).toEqual({
      GOOGLE_CLIENT_ID: 'user-id',
      GOOGLE_CLIENT_SECRET: 'embedded-secret',
      GMAIL_QUOTA_UNITS_PER_MINUTE: '6000',
      APP_DATA_DIR: '/data',
      NODE_ENV: 'production',
    });
    expect(importKey).toBe('k');
  });

  it('works without a user config', () => {
    expect(buildServerEnv({ embedded: {}, dataDir: '/d' })).toEqual({
      env: { APP_DATA_DIR: '/d', NODE_ENV: 'production' },
      importKey: undefined,
    });
  });
});

describe('loadOrCreateKey', () => {
  // Reversible stand-in for the keychain.
  const protector: KeyProtector = {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(`enc:${s}`),
    decrypt: (b) => b.toString().replace(/^enc:/, ''),
  };
  const memory = () => {
    let blob: Buffer | undefined;
    return { read: () => blob, write: (b: Buffer) => void (blob = b), blob: () => blob };
  };

  it('imports the configured key once, then always uses the stored one', () => {
    const store = memory();
    expect(loadOrCreateKey(store, protector, 'dev-key')).toEqual({
      key: 'dev-key',
      source: 'imported',
    });
    expect(store.blob()?.toString()).toBe('enc:dev-key');
    expect(loadOrCreateKey(store, protector, 'other-key')).toEqual({
      key: 'dev-key',
      source: 'keychain',
    });
  });

  it('generates a strong random key when none is configured', () => {
    const { key, source } = loadOrCreateKey(memory(), protector);
    expect(source).toBe('generated');
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  it('refuses to run without keychain encryption', () => {
    expect(() => loadOrCreateKey(memory(), { ...protector, isAvailable: () => false })).toThrow(
      'keychain',
    );
  });
});

describe('navigation policy', () => {
  const origin = 'http://127.0.0.1:52000';
  it('downloads our attachments, opens web links externally, refuses the rest', () => {
    expect(classifyOpen(`${origin}/api/messages/m1/attachments/2`, origin)).toEqual({
      kind: 'download',
      url: `${origin}/api/messages/m1/attachments/2`,
    });
    expect(classifyOpen('https://example.com/a', origin)).toEqual({
      kind: 'external',
      url: 'https://example.com/a',
    });
    expect(classifyOpen(`${origin}/api/tools/send_email`, origin)).toEqual({ kind: 'deny' });
    expect(classifyOpen('file:///etc/passwd', origin)).toEqual({ kind: 'deny' });
    expect(classifyOpen('javascript:alert(1)', origin)).toEqual({ kind: 'deny' });
    expect(classifyOpen('not a url', origin)).toEqual({ kind: 'deny' });
  });

  it('keeps the window on our origin', () => {
    expect(allowNavigation(`${origin}/`, origin)).toBe(true);
    expect(allowNavigation('https://evil.example/', origin)).toBe(false);
    expect(allowNavigation(`${origin}/`, undefined)).toBe(false);
  });
});

describe('status page', () => {
  it('escapes content and blocks scripts', () => {
    const html = decodeURIComponent(
      statusPageUrl({ title: '<b>x</b>', message: 'm' }).split(',')[1]!,
    );
    expect(html).toContain('&#60;b&#62;x');
    expect(html).toContain("default-src 'none'");
  });
});
