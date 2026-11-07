import { withTenant } from '../../../platform/db/database.js';
import { audit, SYSTEM_ACTOR } from '../../../platform/audit/audit.js';
import type { Job } from '../../../platform/events/jobs.js';
import { emit } from '../../../platform/events/outbox.js';
import { RetryableError } from '../../../platform/events/retry.js';
import { accessTokenAad } from '../accounts/credentials.js';
import { GraphApiClient, type OutboundPayload } from '../connector/graph-client.js';
import { GraphApiError } from '../connector/errors.js';
import type { WhatsAppDeps } from '../context.js';
import { optOutCustomer } from '../customers/customers.js';
import { policyFacts, type OutboundContent } from './outbound-service.js';

function buildPayload(to: string, content: OutboundContent): OutboundPayload {
  if (content.kind === 'text') return { type: 'text', to, text: { body: content.text, preview_url: false } };
  return {
    type: 'template',
    to,
    template: {
      name: content.name,
      language: { code: content.language },
      components: content.parameters.length
        ? [{ type: 'body', parameters: content.parameters.map((text) => ({ type: 'text' as const, text })) }]
        : undefined,
    },
  };
}

type Prepared =
  | { kind: 'skip' }
  | { kind: 'send'; client: GraphApiClient; phoneNumberId: string; payload: OutboundPayload; customerId: string; accountId: string };

/**
 * Delivers one queued outbound message.
 *
 * Phase A (transaction): lock the message, re-run the policy against current
 * state, mark it 'sending'. Phase B: call Meta outside any transaction.
 * Phase C (transaction): record the result.
 *
 * A message found already in 'sending' means a previous attempt crashed after
 * possibly reaching Meta; it is failed as ambiguous instead of being resent.
 */
export async function processSendJob(deps: WhatsAppDeps, job: Job): Promise<void> {
  const le = job.legal_entity_id;
  const prepared: Prepared = await withTenant(deps.db, le, async (trx) => {
    const msg = await trx.selectFrom('messages').selectAll().where('id', '=', job.ref_id).forUpdate().executeTakeFirst();
    if (!msg || msg.direction !== 'outbound') return { kind: 'skip' };
    const now = deps.clock.now();

    if (msg.status === 'sending') {
      await trx
        .updateTable('messages')
        .set({ status: 'failed', status_reason: 'ambiguous_delivery', status_updated_at: now })
        .where('id', '=', msg.id)
        .execute();
      await audit(trx, { legalEntityId: le, actor: SYSTEM_ACTOR, action: 'message.outbound.ambiguous', targetType: 'message', targetId: msg.id });
      await emit(trx, le, 'whatsapp.message.needs_review', { messageId: msg.id, reason: 'ambiguous_delivery' });
      return { kind: 'skip' };
    }
    if (msg.status !== 'queued') return { kind: 'skip' };

    const content = msg.content as unknown as OutboundContent;
    const initiatedBy = msg.campaign_id ? 'campaign' : msg.sender_type === 'ai' ? 'ai' : msg.sender_type === 'agent' ? 'agent' : 'system';
    const { decision, customer, account } = await policyFacts(trx, deps, {
      conversationId: msg.conversation_id,
      content,
      initiatedBy,
      campaignId: msg.campaign_id,
    });

    if (!decision.allowed || decision.delivery === 'dry_run') {
      const status = decision.allowed ? 'dry_run' : 'blocked';
      await trx
        .updateTable('messages')
        .set({ status, status_reason: decision.allowed ? null : decision.reason, status_updated_at: now })
        .where('id', '=', msg.id)
        .execute();
      await audit(trx, {
        legalEntityId: le,
        actor: SYSTEM_ACTOR,
        action: `message.outbound.${status}`,
        targetType: 'message',
        targetId: msg.id,
        metadata: { stage: 'pre_send', reason: decision.allowed ? undefined : decision.reason },
      });
      return { kind: 'skip' };
    }

    const fullAccount = await trx.selectFrom('whatsapp_accounts').selectAll().where('id', '=', account.id).executeTakeFirstOrThrow();
    const metaApp = await trx.selectFrom('meta_apps').selectAll().where('id', '=', fullAccount.meta_app_id).executeTakeFirstOrThrow();
    if (!fullAccount.access_token_ciphertext) throw new Error('Account has no access token');
    const client = new GraphApiClient({
      baseUrl: deps.config.graphBaseUrl,
      version: metaApp.graph_api_version,
      accessToken: deps.secrets.decrypt(fullAccount.access_token_ciphertext, accessTokenAad(fullAccount.id)),
      timeoutMs: deps.config.graphTimeoutMs,
      fetch: deps.fetch,
    });

    await trx
      .updateTable('messages')
      .set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1), status_updated_at: now }))
      .where('id', '=', msg.id)
      .execute();
    return {
      kind: 'send',
      client,
      phoneNumberId: fullAccount.phone_number_id,
      payload: buildPayload(customer.wa_id, content),
      customerId: customer.id,
      accountId: fullAccount.id,
    };
  });

  if (prepared.kind === 'skip') return;

  try {
    const result = await prepared.client.sendMessage(prepared.phoneNumberId, prepared.payload);
    await withTenant(deps.db, le, async (trx) => {
      const now = deps.clock.now();
      await trx
        .updateTable('messages')
        .set({ status: 'accepted', wamid: result.wamid, status_reason: null, error: null, status_updated_at: now })
        .where('id', '=', job.ref_id)
        .where('status', '=', 'sending')
        .execute();
      await audit(trx, { legalEntityId: le, actor: SYSTEM_ACTOR, action: 'message.outbound.accepted', targetType: 'message', targetId: job.ref_id, metadata: { wamid: result.wamid } });
    });
  } catch (err) {
    const gErr = err instanceof GraphApiError ? err : new GraphApiError(String((err as Error)?.message ?? err), 0, 'unknown', 'ambiguous');
    const exhausted = job.attempts >= job.max_attempts;
    const retry = gErr.retryable && !exhausted;

    await withTenant(deps.db, le, async (trx) => {
      const now = deps.clock.now();
      const reason = retry
        ? null
        : gErr.sendState === 'ambiguous'
          ? 'ambiguous_delivery'
          : exhausted && gErr.retryable
            ? 'retries_exhausted'
            : gErr.classification;
      await trx
        .updateTable('messages')
        .set({
          status: retry ? 'queued' : 'failed',
          status_reason: reason,
          error: JSON.stringify(gErr.toJSON()) as never,
          status_updated_at: now,
        })
        .where('id', '=', job.ref_id)
        .execute();
      await audit(trx, {
        legalEntityId: le,
        actor: SYSTEM_ACTOR,
        action: retry ? 'message.outbound.retry_scheduled' : 'message.outbound.failed',
        targetType: 'message',
        targetId: job.ref_id,
        metadata: { error: gErr.toJSON(), attempt: job.attempts },
      });

      if (gErr.classification === 'recipient_opted_out') {
        await optOutCustomer(trx, {
          legalEntityId: le,
          customerId: prepared.customerId,
          at: now,
          source: 'meta_error',
          evidence: `Graph API error ${gErr.code} on message ${job.ref_id}`,
          actor: { type: 'meta', id: null },
        });
      }
      if (gErr.classification === 'auth') {
        // A rejected token will fail every send: stop sending until an operator re-verifies.
        await trx
          .updateTable('whatsapp_accounts')
          .set({ status: 'verification_failed', sending_enabled: false, updated_at: now })
          .where('id', '=', prepared.accountId)
          .execute();
        await audit(trx, {
          legalEntityId: le,
          actor: SYSTEM_ACTOR,
          action: 'whatsapp_account.sending_disabled',
          targetType: 'whatsapp_account',
          targetId: prepared.accountId,
          metadata: { reason: 'graph_auth_error', code: gErr.code },
        });
      }
      if (!retry && gErr.sendState === 'ambiguous') {
        await emit(trx, le, 'whatsapp.message.needs_review', { messageId: job.ref_id, reason: 'ambiguous_delivery' });
      }
    });

    if (retry) throw new RetryableError(gErr.message, gErr.retryAfterMs);
  }
}
