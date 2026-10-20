import { describe, expect, it } from 'vitest';
import { AesGcmSecretCipher } from './secret-cipher.js';

const KEY = 'k'.repeat(32);

describe('AesGcmSecretCipher', () => {
  it('round-trips and uses a fresh IV each time', async () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const a = await cipher.encrypt('1//refresh-token-ü');
    const b = await cipher.encrypt('1//refresh-token-ü');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh');
    expect(await cipher.decrypt(a)).toBe('1//refresh-token-ü');
  });

  it('rejects a different key and tampered data', async () => {
    const ciphertext = await new AesGcmSecretCipher(KEY).encrypt('secret');
    await expect(new AesGcmSecretCipher('x'.repeat(32)).decrypt(ciphertext)).rejects.toThrow(
      'Decryption failed',
    );
    const [v, iv, tag, data] = ciphertext.split(':') as [string, string, string, string];
    const flipped = data.startsWith('A') ? `B${data.slice(1)}` : `A${data.slice(1)}`;
    await expect(
      new AesGcmSecretCipher(KEY).decrypt([v, iv, tag, flipped].join(':')),
    ).rejects.toThrow('Decryption failed');
    await expect(new AesGcmSecretCipher(KEY).decrypt('plain-text')).rejects.toThrow(
      'Unrecognized ciphertext format',
    );
  });

  it('requires a key of at least 32 characters', () => {
    expect(() => new AesGcmSecretCipher('short')).toThrow(/at least 32 characters/);
  });
});
