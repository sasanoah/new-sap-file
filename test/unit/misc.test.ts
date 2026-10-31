import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StaticKeyProvider } from '../../src/platform/crypto/key-provider.js';
import { constantTimeEqual, fingerprint, SecretBox } from '../../src/platform/crypto/secrets.js';
import { backoffDelayMs } from '../../src/platform/events/retry.js';
import { loadEnv } from '../../src/platform/config/env.js';
import { detectKeywordIntent, detectLocale } from '../../src/modules/whatsapp/i18n/locale.js';
import { systemMessage } from '../../src/modules/whatsapp/i18n/messages.js';
import { nextStatus } from '../../src/modules/whatsapp/inbound/status-processor.js';
import { canonicalJson, extractText } from '../../src/modules/whatsapp/webhook/payload.js';
import { effectiveRoles } from '../../src/platform/auth/roles.js';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('round-trips and binds ciphertext to its purpose', () => {
    const box = new SecretBox(new StaticKeyProvider('k1', key()));
    const ct = box.encrypt('EAAG-secret', 'acct:1');
    expect(ct).not.toContain('EAAG');
    expect(box.decrypt(ct, 'acct:1')).toBe('EAAG-secret');
    expect(() => box.decrypt(ct, 'acct:2')).toThrow();
  });
  it('detects tampering', () => {
    const box = new SecretBox(new StaticKeyProvider('k1', key()));
    const parts = box.encrypt('value', 'a').split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'a')).toThrow();
  });
  it('decrypts with a previous key after rotation', () => {
    const old = key();
    const before = new SecretBox(new StaticKeyProvider('k1', old)).encrypt('v', 'a');
    const after = new SecretBox(new StaticKeyProvider('k2', key(), `k1:${old}`));
    expect(after.decrypt(before, 'a')).toBe('v');
    expect(after.encrypt('v', 'a').split('.')[1]).toBe('k2');
  });
  it('fingerprints without revealing the secret', () => {
    expect(fingerprint('abc')).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('backoff', () => {
  it('grows exponentially with full jitter and a cap', () => {
    expect(backoffDelayMs(0, { random: () => 0.999 })).toBeLessThan(2000);
    expect(backoffDelayMs(3, { random: () => 0.999 })).toBeGreaterThan(15_000);
    expect(backoffDelayMs(30, { random: () => 0.999 })).toBeLessThanOrEqual(600_000);
    expect(backoffDelayMs(5, { random: () => 0 })).toBe(0);
  });
});

describe('Arabic / English handling', () => {
  it('detects locale from script', () => {
    expect(detectLocale('مرحبا، أريد مرتبة')).toBe('ar');
    expect(detectLocale('Hello, I need a mattress')).toBe('en');
    expect(detectLocale('أريد mattress كبيرة')).toBe('ar');
    expect(detectLocale('12345 👍')).toBeNull();
  });
  it('detects opt-out / opt-in / human keywords as whole messages only', () => {
    expect(detectKeywordIntent('STOP')).toBe('opt_out');
    expect(detectKeywordIntent(' Stop! ')).toBe('opt_out');
    expect(detectKeywordIntent('إيقاف')).toBe('opt_out');
    expect(detectKeywordIntent('إلغاء الاشتراك')).toBe('opt_out');
    expect(detectKeywordIntent('START')).toBe('opt_in');
    expect(detectKeywordIntent('اشتراك')).toBe('opt_in');
    expect(detectKeywordIntent('موظف')).toBe('human');
    expect(detectKeywordIntent('خدمة العملاء')).toBe('human');
    expect(detectKeywordIntent('please do not stop my delivery')).toBeNull();
    expect(detectKeywordIntent('متى يتوقف العرض؟')).toBeNull();
  });
  it('renders tenant-branded system messages in both languages', () => {
    expect(systemMessage('opt_in_confirmed', 'en', { brand: 'Bed Janssen' })).toContain('Bed Janssen');
    expect(systemMessage('opt_in_confirmed', 'ar', { brand: 'Bed Janssen' })).toContain('Bed Janssen');
    expect(systemMessage('handoff_ack', null, { brand: 'X' })).toMatch(/[؀-ۿ]/);
  });
});

describe('message status ordering', () => {
  it('only moves forward', () => {
    expect(nextStatus('accepted', 'sent')).toBe('sent');
    expect(nextStatus('sent', 'delivered')).toBe('delivered');
    expect(nextStatus('read', 'delivered')).toBeNull();
    expect(nextStatus('accepted', 'read')).toBe('read');
    expect(nextStatus('delivered', 'sent')).toBeNull();
  });
  it('lets failures override only undelivered messages', () => {
    expect(nextStatus('sent', 'failed')).toBe('failed');
    expect(nextStatus('accepted', 'failed')).toBe('failed');
    expect(nextStatus('delivered', 'failed')).toBeNull();
    expect(nextStatus('failed', 'delivered')).toBeNull();
  });
});

describe('payload helpers', () => {
  it('produces key-order independent JSON', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
  it('extracts text from text, button and interactive messages', () => {
    const base = { from: '1', id: 'x', timestamp: '1' };
    expect(extractText({ ...base, type: 'text', text: { body: 'hi' } })).toBe('hi');
    expect(extractText({ ...base, type: 'button', button: { text: 'Yes' } })).toBe('Yes');
    expect(extractText({ ...base, type: 'interactive', interactive: { button_reply: { title: 'نعم' } } })).toBe('نعم');
    expect(extractText({ ...base, type: 'image' })).toBeNull();
  });
});

describe('roles', () => {
  it('lets admins act as supervisors and agents but not approvers', () => {
    const r = effectiveRoles(['entity_admin']);
    expect(r.has('agent') && r.has('supervisor')).toBe(true);
    expect(r.has('campaign_approver')).toBe(false);
  });
});

describe('configuration', () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@localhost/db',
    CREDENTIALS_MASTER_KEY: key(),
    AUTH_ISSUER: 'i',
    AUTH_AUDIENCE: 'a',
    AUTH_JWKS_URL: 'https://idp/jwks',
  };
  it('defaults outbound sending to disabled', () => {
    expect(loadEnv(env).WHATSAPP_OUTBOUND_MODE).toBe('disabled');
  });
  it('rejects HS256 auth in production and bad keys', () => {
    expect(() => loadEnv({ ...env, NODE_ENV: 'production', AUTH_HS256_SECRET: 'x'.repeat(40) })).toThrow(/not allowed in production/);
    expect(() => loadEnv({ ...env, CREDENTIALS_MASTER_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => loadEnv({ ...env, AUTH_JWKS_URL: undefined })).toThrow(/AUTH_JWKS_URL/);
  });
});
