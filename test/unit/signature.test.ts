import { describe, expect, it } from 'vitest';
import { isValidSignature, signBody } from '../../src/modules/whatsapp/webhook/signature.js';

const secret = 'app-secret-123';
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

describe('X-Hub-Signature-256 validation', () => {
  it('accepts a correct signature', () => {
    expect(isValidSignature(body, signBody(body, secret), secret)).toBe(true);
  });
  it('rejects a signature made with another secret', () => {
    expect(isValidSignature(body, signBody(body, 'other'), secret)).toBe(false);
  });
  it('rejects when the body was modified (even whitespace)', () => {
    const sig = signBody(body, secret);
    expect(isValidSignature(Buffer.from(body.toString().replace(':', ': ')), sig, secret)).toBe(false);
  });
  it.each([undefined, '', 'sha1=abc', 'sha256=', 'sha256=zz', `sha256=${'a'.repeat(63)}`])('rejects malformed header %s', (h) => {
    expect(isValidSignature(body, h, secret)).toBe(false);
  });
});
