import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Encrypts secrets at rest. Async so an implementation can use an OS keychain.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const FORMAT = 'v1';
const SALT = 'ai-email-agent/secret-cipher/v1';

/** AES-256-GCM with a key derived from APP_SECRET_KEY. */
export class AesGcmSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error(
        'APP_SECRET_KEY must be at least 32 characters (generate one with `openssl rand -base64 32`)',
      );
    }
    this.key = scryptSync(secret, SALT, 32);
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [FORMAT, iv, cipher.getAuthTag(), data]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join(':');
  }

  async decrypt(ciphertext: string): Promise<string> {
    const [format, iv, tag, data, ...rest] = ciphertext.split(':');
    if (format !== FORMAT || !iv || !tag || data === undefined || rest.length > 0) {
      throw new Error('Unrecognized ciphertext format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Decryption failed (wrong key or tampered data)');
    }
  }
}
