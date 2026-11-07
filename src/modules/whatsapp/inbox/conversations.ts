import { sql } from 'kysely';
import type { Tx } from '../../../platform/db/database.js';
import type { HandlingMode } from '../../../platform/db/schema.js';
import { audit, type Actor } from '../../../platform/audit/audit.js';
import { emit } from '../../../platform/events/outbox.js';
import { AppError, conflict, notFound } from '../../../platform/http/errors.js';
import type { Principal } from '../../../platform/auth/roles.js';

/** Returns the open conversation for this customer + phone number, creating one if needed. */
export async function findOrCreateOpenConversation(
  trx: Tx,
  input: { legalEntityId: string; customerId: string; accountId: string; defaultMode: HandlingMode },
) {
  const existing = await trx
    .selectFrom('conversations')
    .selectAll()
    .where('customer_id', '=', input.customerId)
    .where('whatsapp_account_id', '=', input.accountId)
    .where('status', '=', 'open')
    .forUpdate()
    .executeTakeFirst();
  if (existing) return { conversation: existing, created: false };

  const inserted = await trx
    .insertInto('conversations')
    .values({
      legal_entity_id: input.legalEntityId,
      customer_id: input.customerId,
      whatsapp_account_id: input.accountId,
      handling_mode: input.defaultMode,
    })
    // A concurrent worker may have created it; fall through to re-read.
    .onConflict((oc) => oc.columns(['legal_entity_id', 'customer_id', 'whatsapp_account_id']).where('status', '=', 'open').doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { conversation: inserted, created: true };

  const raced = await trx
    .selectFrom('conversations')
    .selectAll()
    .where('customer_id', '=', input.customerId)
    .where('whatsapp_account_id', '=', input.accountId)
    .where('status', '=', 'open')
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { conversation: raced, created: false };
}

export async function loadConversation(trx: Tx, id: string, lock = false) {
  let q = trx.selectFrom('conversations').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const c = await q.executeTakeFirst();
  if (!c) throw notFound('Conversation');
  return c;
}

/** Registers (or refreshes) the calling staff member as an agent of this legal entity. */
export async function ensureAgent(trx: Tx, legalEntityId: string, principal: Principal) {
  return trx
    .insertInto('agents')
    .values({ legal_entity_id: legalEntityId, subject: principal.subject, display_name: principal.displayName })
    .onConflict((oc) => oc.columns(['legal_entity_id', 'subject']).doUpdateSet({ updated_at: new Date() }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateAgentStatus(
  trx: Tx,
  agentId: string,
  patch: { status?: 'available' | 'away' | 'offline'; displayName?: string; languages?: string[] },
) {
  return trx
    .updateTable('agents')
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.displayName ? { display_name: patch.displayName } : {}),
      ...(patch.languages ? { languages: patch.languages } : {}),
      updated_at: new Date(),
    })
    .where('id', '=', agentId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Least-loaded available agent who speaks the customer's language and is below
 * capacity. Returns null when nobody is free; the conversation then waits in
 * the human queue.
 */
export async function pickAgent(trx: Tx, locale: string | null) {
  const rows = await trx
    .selectFrom('agents as a')
    .leftJoin('conversations as c', (j) =>
      j.onRef('c.assigned_agent_id', '=', 'a.id').on('c.status', '=', 'open'),
    )
    .select(['a.id', 'a.max_concurrent', 'a.languages', sql<number>`count(c.id)::int`.as('open_count')])
    .where('a.status', '=', 'available')
    .groupBy('a.id')
    .orderBy('open_count')
    .orderBy('a.updated_at')
    .execute();
  const fits = rows.filter((r) => r.open_count < r.max_concurrent);
  return fits.find((r) => !locale || r.languages.includes(locale)) ?? fits[0] ?? null;
}

export interface HandoffInput {
  legalEntityId: string;
  conversationId: string;
  requestedBy: Actor & { kind: 'customer' | 'ai' | 'agent' | 'system' };
  reason: string;
  toAgentId?: string | null;
  autoAssign?: boolean;
  requestId?: string | null;
}

/**
 * Moves a conversation to humans. With toAgentId it is assigned directly;
 * otherwise it is auto-routed when an agent is free, or left in the queue.
 */
export async function handoffToHuman(trx: Tx, input: HandoffInput) {
  const conv = await loadConversation(trx, input.conversationId, true);
  if (conv.status !== 'open') throw conflict('Conversation is closed');

  let toAgentId = input.toAgentId ?? null;
  if (toAgentId) {
    const agent = await trx.selectFrom('agents').select('id').where('id', '=', toAgentId).executeTakeFirst();
    if (!agent) throw notFound('Agent');
  } else if (input.autoAssign !== false) {
    const customer = await trx.selectFrom('customers').select('preferred_locale').where('id', '=', conv.customer_id).executeTakeFirstOrThrow();
    toAgentId = (await pickAgent(trx, customer.preferred_locale))?.id ?? null;
  }

  const updated = await trx
    .updateTable('conversations')
    .set({ handling_mode: toAgentId ? 'human' : 'human_queue', assigned_agent_id: toAgentId, updated_at: new Date() })
    .where('id', '=', conv.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  await trx
    .insertInto('handoffs')
    .values({
      legal_entity_id: input.legalEntityId,
      conversation_id: conv.id,
      requested_by_type: input.requestedBy.kind,
      requested_by_id: input.requestedBy.id,
      reason: input.reason.slice(0, 500),
      from_agent_id: conv.assigned_agent_id,
      to_agent_id: toAgentId,
    })
    .execute();
  await audit(trx, {
    legalEntityId: input.legalEntityId,
    actor: input.requestedBy,
    action: 'conversation.handoff',
    targetType: 'conversation',
    targetId: conv.id,
    metadata: { reason: input.reason, fromMode: conv.handling_mode, fromAgentId: conv.assigned_agent_id, toAgentId },
    requestId: input.requestId,
  });
  await emit(trx, input.legalEntityId, 'whatsapp.conversation.handoff', {
    conversationId: conv.id,
    reason: input.reason,
    toAgentId,
  });
  return updated;
}

export async function claimConversation(trx: Tx, legalEntityId: string, conversationId: string, agentId: string, actor: Actor, requestId?: string) {
  const conv = await loadConversation(trx, conversationId, true);
  if (conv.status !== 'open') throw conflict('Conversation is closed');
  if (conv.assigned_agent_id && conv.assigned_agent_id !== agentId) {
    throw conflict('Conversation is already assigned to another agent', { assignedAgentId: conv.assigned_agent_id });
  }
  const updated = await trx
    .updateTable('conversations')
    .set({ handling_mode: 'human', assigned_agent_id: agentId, updated_at: new Date() })
    .where('id', '=', conv.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(trx, { legalEntityId, actor, action: 'conversation.claimed', targetType: 'conversation', targetId: conv.id, metadata: { agentId, fromMode: conv.handling_mode }, requestId });
  return updated;
}

export async function returnToAi(trx: Tx, legalEntityId: string, conversationId: string, actor: Actor, requestId?: string) {
  const conv = await loadConversation(trx, conversationId, true);
  if (conv.status !== 'open') throw conflict('Conversation is closed');
  const account = await trx.selectFrom('whatsapp_accounts').select('ai_assistant_enabled').where('id', '=', conv.whatsapp_account_id).executeTakeFirstOrThrow();
  if (!account.ai_assistant_enabled) throw new AppError('precondition_failed', 'AI assistant is not enabled for this phone number');
  const updated = await trx
    .updateTable('conversations')
    .set({ handling_mode: 'ai', assigned_agent_id: null, updated_at: new Date() })
    .where('id', '=', conv.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(trx, { legalEntityId, actor, action: 'conversation.returned_to_ai', targetType: 'conversation', targetId: conv.id, requestId });
  return updated;
}

export async function closeConversation(trx: Tx, legalEntityId: string, conversationId: string, actor: Actor, requestId?: string) {
  const conv = await loadConversation(trx, conversationId, true);
  if (conv.status === 'closed') return conv;
  const now = new Date();
  const updated = await trx
    .updateTable('conversations')
    .set({ status: 'closed', closed_at: now, updated_at: now })
    .where('id', '=', conv.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(trx, { legalEntityId, actor, action: 'conversation.closed', targetType: 'conversation', targetId: conv.id, requestId });
  await emit(trx, legalEntityId, 'whatsapp.conversation.closed', { conversationId: conv.id });
  return updated;
}
