import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';

const VERSION = 'v1';

/**
 * AES-256-GCM encryption for credentials at rest.
 * Format: v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * The associated data binds a ciphertext to its purpose (for example
 * "whatsapp_account:<id>:access_token") so it cannot be swapped between rows.
 */
export class SecretBox {
  constructor(private readonly keys: KeyProvider) {}

  encrypt(plaintext: string, associatedData: string): string {
    const keyId = this.keys.currentKeyId();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.getKey(keyId), iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, keyId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string, associatedData: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('Unsupported ciphertext format');
    const [, keyId, iv, tag, ct] = parts as [string, string, string, string, string];
    const decipher = createDecipheriv('aes-256-gcm', this.keys.getKey(keyId), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Short, non-reversible identifier safe to show in UIs and logs. */
export function fingerprint(secret: string): string {
  return `sha256:${sha256Hex(secret).slice(0, 12)}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still spend comparable time to avoid a length oracle.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
