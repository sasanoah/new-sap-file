import { withTenant } from '../../../platform/db/database.js';
import { audit, type Actor } from '../../../platform/audit/audit.js';
import type { Job } from '../../../platform/events/jobs.js';
import { enqueue } from '../../../platform/events/jobs.js';
import { emit } from '../../../platform/events/outbox.js';
import { AppError, conflict, forbidden, notFound } from '../../../platform/http/errors.js';
import type { WhatsAppDeps } from '../context.js';
import { findOrCreateOpenConversation } from '../inbox/conversations.js';
import { submitOutbound } from '../outbound/outbound-service.js';

export interface CreateCampaignInput {
  name: string;
  whatsappAccountId: string;
  templateId: string;
  customerIds: string[];
  templateParameters: string[];
}

/**
 * Campaigns are the only bulk path. Lifecycle:
 * draft → pending_approval → approved (by someone other than the creator) → running → completed.
 * Every recipient is still checked individually (consent, opt-out, template) at send time.
 */
export async function createCampaign(deps: WhatsAppDeps, le: string, input: CreateCampaignInput, actor: Actor & { id: string }, requestId?: string) {
  const customerIds = [...new Set(input.customerIds)];
  if (customerIds.length === 0) throw new AppError('bad_request', 'Campaign needs at least one recipient');
  if (customerIds.length > deps.config.campaignMaxRecipients) {
    throw new AppError('bad_request', `Campaign audience exceeds the limit of ${deps.config.campaignMaxRecipients} recipients`);
  }
  return withTenant(deps.db, le, async (trx) => {
    const template = await trx
      .selectFrom('message_templates')
      .selectAll()
      .where('id', '=', input.templateId)
      .where('whatsapp_account_id', '=', input.whatsappAccountId)
      .executeTakeFirst();
    if (!template) throw notFound('Template for this phone number');
    if (template.body_parameter_count !== input.templateParameters.length) {
      throw new AppError('bad_request', `Template expects ${template.body_parameter_count} parameters`);
    }
    const found = await trx.selectFrom('customers').select('id').where('id', 'in', customerIds).execute();
    if (found.length !== customerIds.length) throw new AppError('bad_request', 'Some customers do not exist in this legal entity');

    const campaign = await trx
      .insertInto('campaigns')
      .values({
        legal_entity_id: le,
        whatsapp_account_id: input.whatsappAccountId,
        template_id: template.id,
        name: input.name,
        template_parameters: JSON.stringify(input.templateParameters) as never,
        created_by: actor.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('campaign_recipients')
      .values(customerIds.map((customer_id) => ({ legal_entity_id: le, campaign_id: campaign.id, customer_id })))
      .execute();
    await audit(trx, { legalEntityId: le, actor, action: 'campaign.created', targetType: 'campaign', targetId: campaign.id, metadata: { recipients: customerIds.length, template: template.name, category: template.category }, requestId });
    return { ...campaign, recipientCount: customerIds.length };
  });
}

async function loadCampaign(deps: WhatsAppDeps, trx: Parameters<Parameters<typeof withTenant>[2]>[0], id: string) {
  const c = await trx.selectFrom('campaigns').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!c) throw notFound('Campaign');
  return c;
}

export async function submitCampaign(deps: WhatsAppDeps, le: string, id: string, actor: Actor & { id: string }, requestId?: string) {
  return withTenant(deps.db, le, async (trx) => {
    const c = await loadCampaign(deps, trx, id);
    if (c.created_by !== actor.id) throw forbidden('Only the creator can submit a campaign');
    if (c.status !== 'draft') throw conflict(`Campaign is ${c.status}`);
    const row = await trx.updateTable('campaigns').set({ status: 'pending_approval', submitted_at: new Date(), updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, { legalEntityId: le, actor, action: 'campaign.submitted', targetType: 'campaign', targetId: id, requestId });
    return row;
  });
}

export async function decideCampaign(
  deps: WhatsAppDeps,
  le: string,
  id: string,
  decision: 'approved' | 'rejected',
  note: string | null,
  actor: Actor & { id: string },
  requestId?: string,
) {
  return withTenant(deps.db, le, async (trx) => {
    const c = await loadCampaign(deps, trx, id);
    if (c.status !== 'pending_approval') throw conflict(`Campaign is ${c.status}`);
    if (c.created_by === actor.id) throw forbidden('A campaign must be approved by someone other than its creator');
    const row = await trx
      .updateTable('campaigns')
      .set({ status: decision, decided_by: actor.id, decided_at: new Date(), decision_note: note, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, { legalEntityId: le, actor, action: `campaign.${decision}`, targetType: 'campaign', targetId: id, metadata: { note }, requestId });
    return row;
  });
}

export async function launchCampaign(deps: WhatsAppDeps, le: string, id: string, actor: Actor & { id: string }, requestId?: string) {
  return withTenant(deps.db, le, async (trx) => {
    const c = await loadCampaign(deps, trx, id);
    if (c.status !== 'approved') throw conflict('Only approved campaigns can be launched');
    const row = await trx.updateTable('campaigns').set({ status: 'running', launched_at: new Date(), updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await enqueue(trx, { legalEntityId: le, kind: 'campaign_launch', refId: id, maxAttempts: 5 });
    await audit(trx, { legalEntityId: le, actor, action: 'campaign.launched', targetType: 'campaign', targetId: id, requestId });
    await emit(trx, le, 'whatsapp.campaign.launched', { campaignId: id });
    return row;
  });
}

/** Fans a running campaign out into individual, policy-checked, throttled messages. Resumable. */
export async function processCampaignLaunchJob(deps: WhatsAppDeps, job: Job): Promise<void> {
  const le = job.legal_entity_id;
  const campaign = await withTenant(deps.db, le, async (trx) => {
    const c = await trx.selectFrom('campaigns as c').innerJoin('message_templates as t', 't.id', 'c.template_id').select(['c.id', 'c.status', 'c.whatsapp_account_id', 'c.template_parameters', 't.name as template_name', 't.language']).where('c.id', '=', job.ref_id).executeTakeFirst();
    return c;
  });
  if (!campaign || campaign.status !== 'running') return;

  const pending = await withTenant(deps.db, le, (trx) =>
    trx.selectFrom('campaign_recipients').select(['id', 'customer_id']).where('campaign_id', '=', campaign.id).where('status', '=', 'pending').orderBy('id').execute(),
  );

  let slot = 0;
  const start = deps.clock.now().getTime();
  for (const r of pending) {
    await withTenant(deps.db, le, async (trx) => {
      const { conversation } = await findOrCreateOpenConversation(trx, {
        legalEntityId: le,
        customerId: r.customer_id,
        accountId: campaign.whatsapp_account_id,
        defaultMode: 'human_queue',
      });
      const result = await submitOutbound(trx, deps, {
        legalEntityId: le,
        conversationId: conversation.id,
        content: { kind: 'template', name: campaign.template_name, language: campaign.language, parameters: campaign.template_parameters as unknown as string[] },
        idempotencyKey: `campaign:${campaign.id}:${r.customer_id}`,
        initiatedBy: 'campaign',
        actor: { type: 'system', id: `campaign:${campaign.id}` },
        campaignId: campaign.id,
        sendAt: new Date(start + slot * deps.config.campaignSendIntervalMs),
      });
      const skipped = result.message.status === 'blocked';
      if (!skipped) slot++;
      await trx
        .updateTable('campaign_recipients')
        .set({ status: skipped ? 'skipped' : 'queued', skip_reason: skipped ? result.message.status_reason : null, message_id: result.message.id })
        .where('id', '=', r.id)
        .execute();
    });
  }

  await withTenant(deps.db, le, async (trx) => {
    const counts = await trx.selectFrom('campaign_recipients').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).where('campaign_id', '=', campaign.id).groupBy('status').execute();
    await trx.updateTable('campaigns').set({ status: 'completed', updated_at: new Date() }).where('id', '=', campaign.id).where('status', '=', 'running').execute();
    await audit(trx, { legalEntityId: le, actor: { type: 'system', id: null }, action: 'campaign.fanout_completed', targetType: 'campaign', targetId: campaign.id, metadata: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
  });
}
