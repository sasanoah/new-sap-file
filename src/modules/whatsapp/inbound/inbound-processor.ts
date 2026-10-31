import type { Tx } from '../../../platform/db/database.js';
import { audit } from '../../../platform/audit/audit.js';
import { enqueue } from '../../../platform/events/jobs.js';
import { emit } from '../../../platform/events/outbox.js';
import { SERVICE_WINDOW_MS } from '../compliance/policy.js';
import type { WhatsAppDeps } from '../context.js';
import { optInCustomer, optOutCustomer, upsertCustomerByWaId } from '../customers/customers.js';
import { detectKeywordIntent, detectLocale } from '../i18n/locale.js';
import { systemMessage } from '../i18n/messages.js';
import { findOrCreateOpenConversation, handoffToHuman, pickAgent } from '../inbox/conversations.js';
import { submitOutbound } from '../outbound/outbound-service.js';
import { extractText, type InboundMessage, type MessagesValue } from './../webhook/payload.js';

interface AccountRow {
  id: string;
  legal_entity_id: string;
  ai_assistant_enabled: boolean;
}

export async function processInboundMessage(
  trx: Tx,
  deps: WhatsAppDeps,
  account: AccountRow,
  value: MessagesValue,
  msg: InboundMessage,
): Promise<'stored' | 'duplicate'> {
  const le = account.legal_entity_id;
  const contact = value.contacts?.find((c) => c.wa_id === msg.from);
  const text = extractText(msg);
  const locale = detectLocale(text);
  const occurredAt = new Date(Number(msg.timestamp) * 1000);
  if (Number.isNaN(occurredAt.getTime())) throw new Error(`Invalid message timestamp for ${msg.id}`);

  const customer = await upsertCustomerByWaId(trx, le, { waId: msg.from, profileName: contact?.profile?.name, locale });
  const aiActive = account.ai_assistant_enabled && deps.ai !== null;
  const { conversation, created } = await findOrCreateOpenConversation(trx, {
    legalEntityId: le,
    customerId: customer.id,
    accountId: account.id,
    defaultMode: aiActive ? 'ai' : 'human_queue',
  });

  const inserted = await trx
    .insertInto('messages')
    .values({
      legal_entity_id: le,
      conversation_id: conversation.id,
      customer_id: customer.id,
      whatsapp_account_id: account.id,
      direction: 'inbound',
      wamid: msg.id,
      type: msg.type,
      text_body: text,
      content: JSON.stringify(msg) as never,
      sender_type: 'customer',
      sender_id: msg.from,
      status: 'received',
      occurred_at: occurredAt,
      status_updated_at: occurredAt,
    })
    .onConflict((oc) => oc.columns(['legal_entity_id', 'wamid']).where('wamid', 'is not', null).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return 'duplicate';

  // Messages can arrive out of order: the window follows the newest inbound message.
  const lastInbound =
    conversation.last_inbound_at && conversation.last_inbound_at > occurredAt ? conversation.last_inbound_at : occurredAt;
  let conv = await trx
    .updateTable('conversations')
    .set({
      last_inbound_at: lastInbound,
      service_window_expires_at: new Date(lastInbound.getTime() + SERVICE_WINDOW_MS),
      updated_at: new Date(),
    })
    .where('id', '=', conversation.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  if (created && conv.handling_mode === 'human_queue') {
    const agent = await pickAgent(trx, customer.preferred_locale);
    if (agent) {
      conv = await trx
        .updateTable('conversations')
        .set({ handling_mode: 'human', assigned_agent_id: agent.id })
        .where('id', '=', conv.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, { legalEntityId: le, actor: { type: 'system', id: null }, action: 'conversation.auto_assigned', targetType: 'conversation', targetId: conv.id, metadata: { agentId: agent.id } });
    }
  }

  await audit(trx, {
    legalEntityId: le,
    actor: { type: 'customer', id: customer.id },
    action: 'message.inbound.received',
    targetType: 'message',
    targetId: inserted.id,
    metadata: { conversationId: conv.id, type: msg.type },
  });
  await emit(trx, le, 'whatsapp.message.received', {
    messageId: inserted.id,
    conversationId: conv.id,
    customerId: customer.id,
    type: msg.type,
  });

  const entity = await trx.selectFrom('legal_entities').select(['name', 'default_locale']).where('id', '=', le).executeTakeFirstOrThrow();
  const replyLocale = customer.preferred_locale ?? locale ?? entity.default_locale;
  const brand = { brand: entity.name };
  const systemReply = (key: 'opt_out_confirmed' | 'opt_in_confirmed' | 'handoff_ack', purpose?: 'opt_out_confirmation') =>
    submitOutbound(trx, deps, {
      legalEntityId: le,
      conversationId: conv.id,
      content: { kind: 'text', text: systemMessage(key, replyLocale, brand), purpose },
      idempotencyKey: `sys:${key}:${msg.id}`,
      initiatedBy: 'system',
      actor: { type: 'system', id: null },
    });

  const intent = detectKeywordIntent(text);
  const evidence = `WhatsApp message ${msg.id}: "${(text ?? '').slice(0, 100)}"`;
  if (intent === 'opt_out') {
    await optOutCustomer(trx, {
      legalEntityId: le,
      customerId: customer.id,
      at: occurredAt,
      source: 'whatsapp_keyword',
      evidence,
      actor: { type: 'customer', id: customer.id },
    });
    await systemReply('opt_out_confirmed', 'opt_out_confirmation');
    return 'stored';
  }
  if (intent === 'opt_in') {
    await optInCustomer(trx, { legalEntityId: le, customerId: customer.id, source: 'whatsapp_keyword', evidence, actor: { type: 'customer', id: customer.id } });
    await systemReply('opt_in_confirmed');
    return 'stored';
  }
  if (intent === 'human') {
    if (conv.handling_mode === 'ai') {
      await handoffToHuman(trx, {
        legalEntityId: le,
        conversationId: conv.id,
        requestedBy: { type: 'customer', id: customer.id, kind: 'customer' },
        reason: 'customer_requested_human',
      });
    }
    await systemReply('handoff_ack');
    return 'stored';
  }

  if (conv.handling_mode === 'ai' && aiActive) {
    await enqueue(trx, { legalEntityId: le, kind: 'ai_reply', refId: inserted.id, maxAttempts: 3 });
  }
  return 'stored';
}
