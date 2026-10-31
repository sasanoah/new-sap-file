import { withTenant } from '../../../platform/db/database.js';
import { audit } from '../../../platform/audit/audit.js';
import type { Job } from '../../../platform/events/jobs.js';
import { isServiceWindowOpen } from '../compliance/policy.js';
import type { WhatsAppDeps } from '../context.js';
import { systemMessage } from '../i18n/messages.js';
import { handoffToHuman } from '../inbox/conversations.js';
import { submitOutbound } from '../outbound/outbound-service.js';
import type { AiDecision, AiTurn } from './assistant.js';

const HISTORY_LIMIT = 20;
const AI_ACTOR = { type: 'ai' as const, id: 'assistant' };

/**
 * Handles one inbound message in an AI-handled conversation: asks the
 * assistant, then either sends its reply through the normal outbound policy
 * or hands the conversation to a human. The model call happens outside any
 * transaction; state is re-checked afterwards in case a human took over.
 */
export async function processAiReplyJob(deps: WhatsAppDeps, job: Job): Promise<void> {
  if (!deps.ai) return;
  const le = job.legal_entity_id;

  const ctx = await withTenant(deps.db, le, async (trx) => {
    const msg = await trx.selectFrom('messages').select(['id', 'conversation_id', 'occurred_at']).where('id', '=', job.ref_id).executeTakeFirst();
    if (!msg) return null;
    const conv = await trx.selectFrom('conversations').selectAll().where('id', '=', msg.conversation_id).executeTakeFirstOrThrow();
    const account = await trx.selectFrom('whatsapp_accounts').select('ai_assistant_enabled').where('id', '=', conv.whatsapp_account_id).executeTakeFirstOrThrow();
    if (conv.status !== 'open' || conv.handling_mode !== 'ai' || !account.ai_assistant_enabled) return null;
    // Only answer the newest inbound message; older jobs are superseded.
    const newer = await trx
      .selectFrom('messages')
      .select('id')
      .where('conversation_id', '=', conv.id)
      .where('direction', '=', 'inbound')
      .where('occurred_at', '>', msg.occurred_at)
      .executeTakeFirst();
    if (newer) return null;
    const customer = await trx.selectFrom('customers').select(['profile_name', 'preferred_locale']).where('id', '=', conv.customer_id).executeTakeFirstOrThrow();
    const entity = await trx.selectFrom('legal_entities').select(['name', 'default_locale']).where('id', '=', le).executeTakeFirstOrThrow();
    const rows = await trx
      .selectFrom('messages')
      .select(['direction', 'text_body', 'status'])
      .where('conversation_id', '=', conv.id)
      .where('text_body', 'is not', null)
      .where('status', 'not in', ['blocked', 'failed'])
      .orderBy('occurred_at', 'desc')
      .limit(HISTORY_LIMIT)
      .execute();
    const history: AiTurn[] = rows.reverse().map((r) => ({ from: r.direction === 'inbound' ? 'customer' : 'business', text: r.text_body! }));
    return { conv, customer, entity, history };
  });
  if (!ctx) return;

  const decision: AiDecision = await deps.ai.draftReply({
    brand: ctx.entity.name,
    locale: ctx.customer.preferred_locale,
    customerName: ctx.customer.profile_name,
    history: ctx.history,
  });

  await withTenant(deps.db, le, async (trx) => {
    const conv = await trx.selectFrom('conversations').selectAll().where('id', '=', ctx.conv.id).forUpdate().executeTakeFirstOrThrow();
    if (conv.status !== 'open' || conv.handling_mode !== 'ai') return; // a human took over meanwhile

    const confident = decision.action === 'reply' && decision.confidence >= deps.config.aiMinConfidence;
    await audit(trx, {
      legalEntityId: le,
      actor: AI_ACTOR,
      action: confident ? 'ai.reply_drafted' : 'ai.handoff_decided',
      targetType: 'conversation',
      targetId: conv.id,
      metadata: { inboundMessageId: job.ref_id, action: decision.action, confidence: decision.confidence, reason: decision.reason },
    });

    if (confident && isServiceWindowOpen(conv.last_inbound_at, deps.clock.now())) {
      await submitOutbound(trx, deps, {
        legalEntityId: le,
        conversationId: conv.id,
        content: { kind: 'text', text: decision.text },
        idempotencyKey: `ai:${job.ref_id}`,
        initiatedBy: 'ai',
        actor: AI_ACTOR,
      });
      return;
    }

    await handoffToHuman(trx, {
      legalEntityId: le,
      conversationId: conv.id,
      requestedBy: { ...AI_ACTOR, kind: 'ai' },
      reason: decision.action === 'reply' ? `low_confidence:${decision.confidence}` : decision.reason || 'ai_handoff',
    });
    await submitOutbound(trx, deps, {
      legalEntityId: le,
      conversationId: conv.id,
      content: { kind: 'text', text: systemMessage('handoff_ack', ctx.customer.preferred_locale ?? decision.language ?? ctx.entity.default_locale, { brand: ctx.entity.name }) },
      idempotencyKey: `sys:handoff_ack:${job.ref_id}`,
      initiatedBy: 'system',
      actor: { type: 'system', id: null },
    });
  });
}
