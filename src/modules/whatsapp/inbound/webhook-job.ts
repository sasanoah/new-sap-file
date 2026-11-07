import { withTenant } from '../../../platform/db/database.js';
import { audit } from '../../../platform/audit/audit.js';
import type { Job } from '../../../platform/events/jobs.js';
import { countBodyParameters } from '../compliance/policy.js';
import type { WhatsAppDeps } from '../context.js';
import { MessagesValueSchema, TemplateStatusValueSchema } from '../webhook/payload.js';
import { processInboundMessage } from './inbound-processor.js';
import { processStatus } from './status-processor.js';

/** Processes one stored webhook change. Safe to run more than once. */
export async function processWebhookEventJob(deps: WhatsAppDeps, job: Job): Promise<void> {
  await withTenant(deps.db, job.legal_entity_id, async (trx) => {
    const event = await trx.selectFrom('webhook_events').selectAll().where('id', '=', job.ref_id).forUpdate().executeTakeFirst();
    if (!event || event.status === 'processed') return;
    const payload = event.payload as unknown as { entryId: string; value: unknown };
    const account = await trx
      .selectFrom('whatsapp_accounts')
      .select(['id', 'legal_entity_id', 'ai_assistant_enabled'])
      .where('id', '=', event.whatsapp_account_id)
      .executeTakeFirstOrThrow();

    if (event.field === 'messages') {
      const value = MessagesValueSchema.parse(payload.value);
      for (const s of value.statuses ?? []) await processStatus(trx, deps, job.legal_entity_id, s);
      for (const m of value.messages ?? []) await processInboundMessage(trx, deps, account, value, m);
      if (value.errors?.length) deps.log.warn({ errors: value.errors, accountId: account.id }, 'webhook reported errors');
    } else if (event.field === 'message_template_status_update') {
      const v = TemplateStatusValueSchema.parse(payload.value);
      const updated = await trx
        .updateTable('message_templates')
        .set({ status: v.event.toUpperCase(), synced_at: new Date() })
        .where('whatsapp_account_id', '=', account.id)
        .where('name', '=', v.message_template_name)
        .where('language', '=', v.message_template_language)
        .returning(['id', 'components'])
        .execute();
      for (const t of updated) {
        await trx
          .updateTable('message_templates')
          .set({ body_parameter_count: countBodyParameters(t.components as unknown[]) })
          .where('id', '=', t.id)
          .execute();
        await audit(trx, {
          legalEntityId: job.legal_entity_id,
          actor: { type: 'meta', id: null },
          action: 'template.status_changed',
          targetType: 'message_template',
          targetId: t.id,
          metadata: { status: v.event, reason: v.reason ?? null },
        });
      }
    }

    await trx.updateTable('webhook_events').set({ status: 'processed', processed_at: new Date(), error: null }).where('id', '=', event.id).execute();
  });
}
