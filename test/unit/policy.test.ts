import { describe, expect, it } from 'vitest';
import { countBodyParameters, evaluateOutboundPolicy, isServiceWindowOpen, SERVICE_WINDOW_MS, type PolicyInput } from '../../src/modules/whatsapp/compliance/policy.js';

const now = new Date('2026-10-18T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  now,
  outboundMode: 'live',
  initiatedBy: 'agent',
  account: { status: 'verified', sendingEnabled: true },
  customer: { optedOutAt: null },
  lastInboundAt: hoursAgo(1),
  content: { kind: 'text' },
  marketingConsent: 'none',
  campaignStatus: null,
  ...over,
});

const template = (over: Record<string, unknown> = {}) => ({
  kind: 'template' as const,
  requestedLanguage: 'ar',
  parameterCount: 1,
  template: { status: 'APPROVED', category: 'UTILITY' as const, language: 'ar', bodyParameterCount: 1, ...over },
});

const reasonOf = (input: PolicyInput) => {
  const d = evaluateOutboundPolicy(input);
  return d.allowed ? `allowed:${d.delivery}` : d.reason;
};

describe('24-hour customer service window', () => {
  it('allows free-form text inside the window', () => {
    expect(reasonOf(base())).toBe('allowed:send');
  });
  it('blocks free-form text after 24 hours', () => {
    expect(reasonOf(base({ lastInboundAt: hoursAgo(24.01) }))).toBe('outside_service_window');
  });
  it('blocks free-form text when the customer never wrote', () => {
    expect(reasonOf(base({ lastInboundAt: null }))).toBe('outside_service_window');
  });
  it('treats the exact 24h boundary as closed', () => {
    expect(isServiceWindowOpen(new Date(now.getTime() - SERVICE_WINDOW_MS), now)).toBe(false);
    expect(isServiceWindowOpen(new Date(now.getTime() - SERVICE_WINDOW_MS + 1), now)).toBe(true);
  });
  it('allows an approved utility template outside the window', () => {
    expect(reasonOf(base({ lastInboundAt: null, content: template() }))).toBe('allowed:send');
  });
});

describe('templates', () => {
  it('requires the template to be registered', () => {
    expect(reasonOf(base({ content: { ...template(), template: null } }))).toBe('template_not_found');
  });
  it.each(['PENDING', 'REJECTED', 'PAUSED', 'DISABLED'])('rejects %s templates', (status) => {
    expect(reasonOf(base({ content: template({ status }) }))).toBe('template_not_approved');
  });
  it('rejects a language mismatch', () => {
    expect(reasonOf(base({ content: { ...template(), requestedLanguage: 'en' } }))).toBe('template_language_mismatch');
  });
  it('rejects a parameter count mismatch', () => {
    expect(reasonOf(base({ content: { ...template(), parameterCount: 2 } }))).toBe('template_parameter_mismatch');
  });
  it('never lets the AI send templates', () => {
    expect(reasonOf(base({ initiatedBy: 'ai', content: template() }))).toBe('ai_cannot_send_templates');
  });
});

describe('marketing and consent', () => {
  const marketing = template({ category: 'MARKETING' });
  it('blocks marketing templates sent directly by an agent, even with consent', () => {
    expect(reasonOf(base({ content: marketing, marketingConsent: 'granted' }))).toBe('marketing_requires_approved_campaign');
  });
  it('blocks marketing from a campaign that is not running', () => {
    for (const status of ['draft', 'pending_approval', 'approved', 'rejected', 'cancelled']) {
      expect(reasonOf(base({ initiatedBy: 'campaign', campaignStatus: status, content: marketing, marketingConsent: 'granted' }))).toBe('marketing_requires_approved_campaign');
    }
  });
  it('requires granted consent inside a running campaign', () => {
    expect(reasonOf(base({ initiatedBy: 'campaign', campaignStatus: 'running', content: marketing, marketingConsent: 'none' }))).toBe('marketing_consent_missing');
    expect(reasonOf(base({ initiatedBy: 'campaign', campaignStatus: 'running', content: marketing, marketingConsent: 'revoked' }))).toBe('marketing_consent_missing');
    expect(reasonOf(base({ initiatedBy: 'campaign', campaignStatus: 'running', content: marketing, marketingConsent: 'granted' }))).toBe('allowed:send');
  });
});

describe('opt-out', () => {
  it('blocks all templates for opted-out customers', () => {
    expect(reasonOf(base({ customer: { optedOutAt: hoursAgo(5) }, content: template() }))).toBe('customer_opted_out');
  });
  it('blocks replies unless the customer wrote again after opting out', () => {
    expect(reasonOf(base({ customer: { optedOutAt: hoursAgo(1) }, lastInboundAt: hoursAgo(2) }))).toBe('customer_opted_out');
    expect(reasonOf(base({ customer: { optedOutAt: hoursAgo(2) }, lastInboundAt: hoursAgo(1) }))).toBe('allowed:send');
  });
  it('allows only the system opt-out confirmation right after opting out', () => {
    const optedOut = { customer: { optedOutAt: hoursAgo(1) }, lastInboundAt: hoursAgo(1) };
    expect(reasonOf(base({ ...optedOut, initiatedBy: 'system', content: { kind: 'text', optOutConfirmation: true } }))).toBe('allowed:send');
    expect(reasonOf(base({ ...optedOut, initiatedBy: 'agent', content: { kind: 'text', optOutConfirmation: true } }))).toBe('customer_opted_out');
  });
});

describe('operational gates', () => {
  it('never sends when outbound is disabled', () => {
    const d = evaluateOutboundPolicy(base({ outboundMode: 'disabled' }));
    expect(d).toMatchObject({ allowed: false, reason: 'outbound_disabled', kind: 'gate' });
  });
  it('dry run passes compliance but never sends, even for unverified accounts', () => {
    expect(reasonOf(base({ outboundMode: 'dry_run', account: { status: 'pending_verification', sendingEnabled: false } }))).toBe('allowed:dry_run');
  });
  it('live mode requires a verified account with sending enabled', () => {
    expect(reasonOf(base({ account: { status: 'pending_verification', sendingEnabled: false } }))).toBe('account_not_enabled');
    expect(reasonOf(base({ account: { status: 'verified', sendingEnabled: false } }))).toBe('account_not_enabled');
  });
  it('reports compliance problems before gates', () => {
    const d = evaluateOutboundPolicy(base({ outboundMode: 'disabled', lastInboundAt: null }));
    expect(d).toMatchObject({ allowed: false, reason: 'outside_service_window', kind: 'compliance' });
  });
});

describe('countBodyParameters', () => {
  it('counts distinct placeholders in the BODY component', () => {
    expect(countBodyParameters([{ type: 'HEADER', text: '{{1}}' }, { type: 'BODY', text: 'Hi {{1}}, order {{2}} ({{1}})' }])).toBe(2);
    expect(countBodyParameters([{ type: 'BODY', text: 'مرحباً {{ name }}' }])).toBe(1);
    expect(countBodyParameters([{ type: 'BODY', text: 'No params' }])).toBe(0);
    expect(countBodyParameters([])).toBe(0);
  });
});
