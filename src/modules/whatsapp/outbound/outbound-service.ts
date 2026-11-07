import type { Tx } from '../../../platform/db/database.js';
import type { MessageStatus } from '../../../platform/db/schema.js';
import { audit, type Actor } from '../../../platform/audit/audit.js';
import { enqueue } from '../../../platform/events/jobs.js';
import { emit } from '../../../platform/events/outbox.js';
import { AppError, conflict } from '../../../platform/http/errors.js';
import { getMarketingConsent } from '../customers/customers.js';
import { evaluateOutboundPolicy, type ContentFacts, type Initiator, type PolicyDecision } from '../compliance/policy.js';
import type { WhatsAppDeps } from '../context.js';
import { loadConversation } from '../inbox/conversations.js';

export type OutboundContent =
  | { kind: 'text'; text: string; purpose?: 'opt_out_confirmation' }
  | { kind: 'template'; name: string; language: string; parameters: string[] };

export interface OutboundRequest {
  legalEntityId: string;
  conversationId: string;
  content: OutboundContent;
  idempotencyKey: string;
  initiatedBy: Initiator;
  actor: Actor;
  campaignId?: string | null;
  requestId?: string | null;
  /** Earliest send time (campaign throttling). */
  sendAt?: Date;
}

export type MessageRow = NonNullable<Awaited<ReturnType<typeof insertOutbound>>>;

export interface OutboundResult {
  message: MessageRow;
  decision: PolicyDecision | null;
  duplicate: boolean;
}

const MAX_TEXT = 4096;

/** Gathers the facts the policy needs for a message on a given conversation. */
export async function policyFacts(
  trx: Tx,
  deps: WhatsAppDeps,
  input: { conversationId: string; content: OutboundContent; initiatedBy: Initiator; campaignId?: string | null },
) {
  const conv = await loadConversation(trx, input.conversationId);
  const [account, customer] = await Promise.all([
    trx.selectFrom('whatsapp_accounts').select(['id', 'status', 'sending_enabled', 'phone_number_id']).where('id', '=', conv.whatsapp_account_id).executeTakeFirstOrThrow(),
    trx.selectFrom('customers').select(['id', 'wa_id', 'opted_out_at']).where('id', '=', conv.customer_id).executeTakeFirstOrThrow(),
  ]);

  let template: Awaited<ReturnType<typeof findTemplate>> = undefined;
  let content: ContentFacts = {
    kind: 'text',
    optOutConfirmation: input.content.kind === 'text' && input.content.purpose === 'opt_out_confirmation',
  };
  if (input.content.kind === 'template') {
    template = await findTemplate(trx, account.id, input.content.name, input.content.language);
    content = {
      kind: 'template',
      requestedLanguage: input.content.language,
      parameterCount: input.content.parameters.length,
      template: template
        ? { status: template.status, category: template.category, language: template.language, bodyParameterCount: template.body_parameter_count }
        : null,
    };
  }

  const campaign = input.campaignId
    ? await trx.selectFrom('campaigns').select('status').where('id', '=', input.campaignId).executeTakeFirst()
    : undefined;

  const decision = evaluateOutboundPolicy({
    now: deps.clock.now(),
    outboundMode: deps.config.outboundMode,
    initiatedBy: input.initiatedBy,
    account: { status: account.status, sendingEnabled: account.sending_enabled },
    customer: { optedOutAt: customer.opted_out_at },
    lastInboundAt: conv.last_inbound_at,
    content,
    marketingConsent: await getMarketingConsent(trx, customer.id),
    campaignStatus: campaign?.status ?? null,
  });
  return { conv, account, customer, template, decision };
}

async function findTemplate(trx: Tx, accountId: string, name: string, language: string) {
  return trx
    .selectFrom('message_templates')
    .selectAll()
    .where('whatsapp_account_id', '=', accountId)
    .where('name', '=', name)
    .where('language', '=', language)
    .executeTakeFirst();
}

async function insertOutbound(
  trx: Tx,
  values: {
    legalEntityId: string;
    conversationId: string;
    customerId: string;
    accountId: string;
    content: OutboundContent;
    templateId: string | null;
    campaignId: string | null;
    actor: Actor;
    initiatedBy: Initiator;
    status: MessageStatus;
    statusReason: string | null;
    idempotencyKey: string;
    now: Date;
  },
) {
  const senderType = values.initiatedBy === 'ai' ? 'ai' : values.initiatedBy === 'agent' ? 'agent' : 'system';
  return trx
    .insertInto('messages')
    .values({
      legal_entity_id: values.legalEntityId,
      conversation_id: values.conversationId,
      customer_id: values.customerId,
      whatsapp_account_id: values.accountId,
      direction: 'outbound',
      type: values.content.kind,
      text_body: values.content.kind === 'text' ? values.content.text : null,
      content: JSON.stringify(values.content) as never,
      template_id: values.templateId,
      campaign_id: values.campaignId,
      sender_type: senderType,
      sender_id: values.actor.id,
      status: values.status,
      status_reason: values.statusReason,
      idempotency_key: values.idempotencyKey,
      occurred_at: values.now,
      status_updated_at: values.now,
    })
    .onConflict((oc) => oc.columns(['legal_entity_id', 'idempotency_key']).where('idempotency_key', 'is not', null).doNothing())
    .returningAll()
    .executeTakeFirst();
}

/**
 * Accepts an outbound message. The policy decides the outcome:
 *  - allowed + live     → status 'queued', a send job is enqueued
 *  - allowed + dry run  → status 'dry_run', nothing is sent
 *  - denied             → status 'blocked' with the reason (persisted and audited)
 * Repeating a request with the same idempotency key returns the original message.
 */
export async function submitOutbound(trx: Tx, deps: WhatsAppDeps, req: OutboundRequest): Promise<OutboundResult> {
  if (!/^[\w:.\-]{8,128}$/.test(req.idempotencyKey)) {
    throw new AppError('bad_request', 'idempotencyKey must be 8-128 characters of [A-Za-z0-9_:.-]');
  }
  const existing = await trx
    .selectFrom('messages')
    .selectAll()
    .where('idempotency_key', '=', req.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    if (existing.conversation_id !== req.conversationId) throw conflict('idempotencyKey already used for another conversation');
    return { message: existing as MessageRow, decision: null, duplicate: true };
  }

  if (req.content.kind === 'text') {
    const text = req.content.text.trim();
    if (!text) throw new AppError('bad_request', 'Message text is empty');
    if (text.length > MAX_TEXT) throw new AppError('bad_request', `Message text exceeds ${MAX_TEXT} characters`);
    req = { ...req, content: { ...req.content, text } };
  }

  const { conv, account, customer, template, decision } = await policyFacts(trx, deps, req);
  if (conv.status !== 'open') throw conflict('Conversation is closed');

  const now = deps.clock.now();
  const status: MessageStatus = !decision.allowed ? 'blocked' : decision.delivery === 'dry_run' ? 'dry_run' : 'queued';
  const message = await insertOutbound(trx, {
    legalEntityId: req.legalEntityId,
    conversationId: conv.id,
    customerId: customer.id,
    accountId: account.id,
    content: req.content,
    templateId: template?.id ?? null,
    campaignId: req.campaignId ?? null,
    actor: req.actor,
    initiatedBy: req.initiatedBy,
    status,
    statusReason: decision.allowed ? null : decision.reason,
    idempotencyKey: req.idempotencyKey,
    now,
  });
  if (!message) {
    // Lost a race with a concurrent request using the same key.
    const raced = await trx.selectFrom('messages').selectAll().where('idempotency_key', '=', req.idempotencyKey).executeTakeFirstOrThrow();
    return { message: raced as MessageRow, decision: null, duplicate: true };
  }

  if (status === 'queued') {
    await enqueue(trx, { legalEntityId: req.legalEntityId, kind: 'send_message', refId: message.id, runAt: req.sendAt });
  }
  if (status !== 'blocked') {
    await trx.updateTable('conversations').set({ last_outbound_at: now, updated_at: now }).where('id', '=', conv.id).execute();
  }

  await audit(trx, {
    legalEntityId: req.legalEntityId,
    actor: req.actor,
    action: `message.outbound.${status}`,
    targetType: 'message',
    targetId: message.id,
    metadata: {
      conversationId: conv.id,
      kind: req.content.kind,
      template: req.content.kind === 'template' ? { name: req.content.name, language: req.content.language } : undefined,
      campaignId: req.campaignId ?? undefined,
      reason: decision.allowed ? undefined : decision.reason,
    },
    requestId: req.requestId,
  });
  await emit(trx, req.legalEntityId, 'whatsapp.message.outbound', { messageId: message.id, conversationId: conv.id, status });
  return { message, decision, duplicate: false };
}
