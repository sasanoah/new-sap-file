/**
 * Supplies data-encryption keys by id. Phase 1 reads keys from configuration;
 * a KMS-backed provider can implement the same interface later.
 */
export interface KeyProvider {
  currentKeyId(): string;
  getKey(keyId: string): Buffer;
}

export class StaticKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly current: string,
    currentKeyBase64: string,
    previous?: string,
  ) {
    this.keys.set(current, decodeKey(currentKeyBase64, current));
    for (const pair of (previous ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = pair.indexOf(':');
      if (idx <= 0) throw new Error('CREDENTIALS_PREVIOUS_KEYS entries must be keyId:base64key');
      const id = pair.slice(0, idx);
      this.keys.set(id, decodeKey(pair.slice(idx + 1), id));
    }
  }

  currentKeyId(): string {
    return this.current;
  }

  getKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Unknown credentials key id "${keyId}"`);
    return key;
  }
}

function decodeKey(b64: string, id: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`Credentials key "${id}" must be 32 bytes`);
  return key;
}
