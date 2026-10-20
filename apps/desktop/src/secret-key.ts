import { randomBytes } from 'node:crypto';

/** Where the protected key blob is stored (a file in the app's data directory). */
export interface KeyStore {
  read(): Buffer | undefined;
  write(data: Buffer): void;
}

/** OS-backed encryption (Electron safeStorage → macOS Keychain). */
export interface KeyProtector {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * The key that encrypts stored Google tokens. It only ever exists on disk encrypted by the OS
 * keychain. First launch imports `importKey` (so the app and the dev server can share a login)
 * or generates a random one; afterwards the stored key always wins.
 */
export function loadOrCreateKey(
  store: KeyStore,
  protector: KeyProtector,
  importKey?: string,
): { key: string; source: 'keychain' | 'imported' | 'generated' } {
  if (!protector.isAvailable()) throw new Error('OS keychain encryption is not available');
  const existing = store.read();
  if (existing) return { key: protector.decrypt(existing), source: 'keychain' };
  const key = importKey ?? randomBytes(32).toString('base64');
  store.write(protector.encrypt(key));
  return { key, source: importKey ? 'imported' : 'generated' };
}
