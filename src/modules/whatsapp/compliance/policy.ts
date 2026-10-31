import type { AccountStatus, TemplateCategory } from '../../../platform/db/schema.js';

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type OutboundMode = 'disabled' | 'dry_run' | 'live';
export type Initiator = 'agent' | 'ai' | 'system' | 'campaign';
export type ConsentState = 'granted' | 'revoked' | 'none';

export interface TemplateFacts {
  status: string;
  category: TemplateCategory;
  language: string;
  bodyParameterCount: number;
}

export type ContentFacts =
  // optOutConfirmation: the one system reply allowed right after a customer opts out.
  | { kind: 'text'; optOutConfirmation?: boolean }
  | { kind: 'template'; template: TemplateFacts | null; requestedLanguage: string; parameterCount: number };

export interface PolicyInput {
  now: Date;
  outboundMode: OutboundMode;
  initiatedBy: Initiator;
  account: { status: AccountStatus; sendingEnabled: boolean };
  customer: { optedOutAt: Date | null };
  lastInboundAt: Date | null;
  content: ContentFacts;
  marketingConsent: ConsentState;
  campaignStatus: string | null;
}

export type PolicyReason =
  | 'outside_service_window'
  | 'customer_opted_out'
  | 'template_not_found'
  | 'template_not_approved'
  | 'template_language_mismatch'
  | 'template_parameter_mismatch'
  | 'marketing_requires_approved_campaign'
  | 'marketing_consent_missing'
  | 'ai_cannot_send_templates'
  | 'outbound_disabled'
  | 'account_not_enabled';

export type PolicyDecision =
  | { allowed: true; delivery: 'send' | 'dry_run' }
  | { allowed: false; reason: PolicyReason; kind: 'compliance' | 'gate'; message: string };

const deny = (reason: PolicyReason, kind: 'compliance' | 'gate', message: string): PolicyDecision => ({
  allowed: false,
  reason,
  kind,
  message,
});

export function isServiceWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  return lastInboundAt !== null && now.getTime() < lastInboundAt.getTime() + SERVICE_WINDOW_MS;
}

/**
 * Single decision point for every outbound WhatsApp message. Pure and
 * deterministic: evaluated when a message is accepted and again right before
 * the network call, so a consent or window change in between is honoured.
 *
 * Compliance rules (content-level) are checked before operational gates, so
 * callers learn about a rule violation even while sending is still disabled.
 */
export function evaluateOutboundPolicy(input: PolicyInput): PolicyDecision {
  const { content, now } = input;
  const windowOpen = isServiceWindowOpen(input.lastInboundAt, now);
  const optedOut = input.customer.optedOutAt !== null;

  if (content.kind === 'text') {
    if (!windowOpen) {
      return deny('outside_service_window', 'compliance', 'Free-form messages are only allowed within 24 hours of the customer’s last message; use an approved template.');
    }
    if (optedOut && !(content.optOutConfirmation && input.initiatedBy === 'system')) {
      // Customer may still get replies if they wrote to us after opting out.
      const reengaged = input.lastInboundAt !== null && input.lastInboundAt > input.customer.optedOutAt!;
      if (!reengaged) return deny('customer_opted_out', 'compliance', 'Customer has opted out and has not contacted us since.');
    }
  } else {
    if (input.initiatedBy === 'ai') {
      return deny('ai_cannot_send_templates', 'compliance', 'The AI assistant may only reply within the service window.');
    }
    if (optedOut) return deny('customer_opted_out', 'compliance', 'Customer has opted out of business-initiated messages.');
    const t = content.template;
    if (!t) return deny('template_not_found', 'compliance', 'Template is not registered for this phone number; sync templates first.');
    if (t.status !== 'APPROVED') return deny('template_not_approved', 'compliance', `Template status is ${t.status}; only APPROVED templates can be sent.`);
    if (t.language !== content.requestedLanguage) {
      return deny('template_language_mismatch', 'compliance', `Template is approved for ${t.language}, not ${content.requestedLanguage}.`);
    }
    if (t.bodyParameterCount !== content.parameterCount) {
      return deny('template_parameter_mismatch', 'compliance', `Template expects ${t.bodyParameterCount} body parameters, got ${content.parameterCount}.`);
    }
    if (t.category === 'MARKETING') {
      // 'completed' means fan-out finished while throttled sends are still pending;
      // a cancelled campaign stops any message not yet sent.
      if (input.initiatedBy !== 'campaign' || !['running', 'completed'].includes(input.campaignStatus ?? '')) {
        return deny('marketing_requires_approved_campaign', 'compliance', 'Marketing templates can only be sent through a human-approved campaign.');
      }
      if (input.marketingConsent !== 'granted') {
        return deny('marketing_consent_missing', 'compliance', 'Customer has not granted marketing consent.');
      }
    }
  }

  if (input.outboundMode === 'disabled') {
    return deny('outbound_disabled', 'gate', 'Outbound sending is disabled for this deployment (WHATSAPP_OUTBOUND_MODE=disabled).');
  }
  if (input.outboundMode === 'dry_run') return { allowed: true, delivery: 'dry_run' };
  if (input.account.status !== 'verified' || !input.account.sendingEnabled) {
    return deny('account_not_enabled', 'gate', 'This phone number has not passed verification or sending has not been enabled by a platform admin.');
  }
  return { allowed: true, delivery: 'send' };
}

/** Counts {{n}} placeholders in a template's BODY component. */
export function countBodyParameters(components: unknown[]): number {
  const body = components.find(
    (c): c is { type: string; text?: string } =>
      typeof c === 'object' && c !== null && String((c as { type?: unknown }).type).toUpperCase() === 'BODY',
  );
  if (!body?.text) return 0;
  const found = new Set<string>();
  for (const m of body.text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) found.add(m[1]!);
  return found.size;
}
