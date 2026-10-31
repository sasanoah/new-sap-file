import type { Tx } from '../../../platform/db/database.js';
import type { MessageStatus } from '../../../platform/db/schema.js';
import { audit } from '../../../platform/audit/audit.js';
import { emit } from '../../../platform/events/outbox.js';
import { RetryableError } from '../../../platform/events/retry.js';
import { classifyGraphError } from '../connector/errors.js';
import type { WhatsAppDeps } from '../context.js';
import { optOutCustomer } from '../customers/customers.js';
import type { StatusUpdate } from '../webhook/payload.js';

const RANK: Partial<Record<MessageStatus, number>> = { queued: 0, sending: 1, accepted: 2, sent: 3, delivered: 4, read: 5 };
const META_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
/** How long a status for an unknown wamid is retried, to cover the send/accept race. */
const UNKNOWN_WAMID_GRACE_MS = 15 * 60_000;

/** Decides whether a status update moves the message forward. Exported for tests. */
export function nextStatus(current: MessageStatus, incoming: 'sent' | 'delivered' | 'read' | 'failed'): MessageStatus | null {
  const cur = RANK[current];
  if (incoming === 'failed') {
    // A failure cannot undo a confirmed delivery.
    if (current === 'failed' || (cur !== undefined && cur >= RANK.delivered!)) return null;
    return 'failed';
  }
  const inc = RANK[incoming]!;
  if (current === 'failed') return null;
  if (cur === undefined || inc > cur) return incoming;
  return null;
}

export async function processStatus(trx: Tx, deps: WhatsAppDeps, legalEntityId: string, s: StatusUpdate): Promise<void> {
  if (!META_STATUSES.has(s.status)) return;
  const occurredAt = new Date(Number(s.timestamp) * 1000);
  const msg = await trx
    .selectFrom('messages')
    .select(['id', 'status', 'customer_id', 'conversation_id'])
    .where('wamid', '=', s.id)
    .where('direction', '=', 'outbound')
    .forUpdate()
    .executeTakeFirst();
  if (!msg) {
    if (deps.clock.now().getTime() - occurredAt.getTime() < UNKNOWN_WAMID_GRACE_MS) {
      throw new RetryableError(`Status for unknown wamid ${s.id}; message may not be recorded yet`, 30_000);
    }
    deps.log.warn({ wamid: s.id, status: s.status }, 'dropping status for unknown message');
    return;
  }

  const event = await trx
    .insertInto('message_status_events')
    .values({
      legal_entity_id: legalEntityId,
      message_id: msg.id,
      wamid: s.id,
      status: s.status,
      occurred_at: occurredAt,
      errors: s.errors ? (JSON.stringify(s.errors) as never) : null,
      pricing: s.pricing ? (JSON.stringify(s.pricing) as never) : null,
    })
    .onConflict((oc) => oc.columns(['message_id', 'status', 'occurred_at']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!event) return; // duplicate delivery

  const incoming = s.status as 'sent' | 'delivered' | 'read' | 'failed';
  const next = nextStatus(msg.status, incoming);
  if (!next) return;

  const firstError = s.errors?.[0] as { code?: number; title?: string; message?: string } | undefined;
  const classification = next === 'failed' ? classifyGraphError(400, firstError?.code) : null;
  await trx
    .updateTable('messages')
    .set({
      status: next,
      status_updated_at: occurredAt,
      ...(next === 'failed' ? { status_reason: classification, error: JSON.stringify({ errors: s.errors ?? [] }) as never } : {}),
    })
    .where('id', '=', msg.id)
    .execute();

  if (next === 'failed') {
    await audit(trx, {
      legalEntityId,
      actor: { type: 'meta', id: null },
      action: 'message.outbound.failed',
      targetType: 'message',
      targetId: msg.id,
      metadata: { code: firstError?.code, title: firstError?.title, classification },
    });
    if (classification === 'recipient_opted_out') {
      await optOutCustomer(trx, {
        legalEntityId,
        customerId: msg.customer_id,
        at: occurredAt,
        source: 'meta_error',
        evidence: `Status webhook error ${firstError?.code} for ${s.id}`,
        actor: { type: 'meta', id: null },
      });
    }
  }
  await emit(trx, legalEntityId, 'whatsapp.message.status', { messageId: msg.id, conversationId: msg.conversation_id, status: next });
}
