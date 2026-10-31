import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validates Meta's X-Hub-Signature-256 header: "sha256=" + hex HMAC-SHA256 of
 * the exact raw request body, keyed with the Meta app secret.
 */
export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
