import { withTenant } from '../../../platform/db/database.js';
import { audit, type Actor } from '../../../platform/audit/audit.js';
import { AppError } from '../../../platform/http/errors.js';
import { graphClientForAccount } from '../accounts/credentials.js';
import { countBodyParameters } from '../compliance/policy.js';
import { GraphApiError } from '../connector/errors.js';
import type { WhatsAppDeps } from '../context.js';

const CATEGORIES = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION']);

/** Pulls the WABA's templates from Meta into the local registry (used by the compliance policy). */
export async function syncTemplates(deps: WhatsAppDeps, legalEntityId: string, accountId: string, actor: Actor, requestId?: string) {
  const { account, client } = await withTenant(deps.db, legalEntityId, (trx) => graphClientForAccount(trx, deps, accountId));
  let remote;
  try {
    remote = await client.listTemplates(account.waba_id);
  } catch (err) {
    if (err instanceof GraphApiError) throw new AppError('upstream_error', `Meta rejected template sync: ${err.message}`, err.toJSON());
    throw err;
  }
  return withTenant(deps.db, legalEntityId, async (trx) => {
    let upserted = 0;
    for (const t of remote) {
      if (!CATEGORIES.has(t.category)) continue;
      const components = t.components ?? [];
      await trx
        .insertInto('message_templates')
        .values({
          legal_entity_id: legalEntityId,
          whatsapp_account_id: account.id,
          meta_template_id: t.id,
          name: t.name,
          language: t.language,
          category: t.category as 'MARKETING' | 'UTILITY' | 'AUTHENTICATION',
          status: t.status,
          components: JSON.stringify(components) as never,
          body_parameter_count: countBodyParameters(components),
        })
        .onConflict((oc) =>
          oc.columns(['whatsapp_account_id', 'name', 'language']).doUpdateSet((eb) => ({
            meta_template_id: eb.ref('excluded.meta_template_id'),
            category: eb.ref('excluded.category'),
            status: eb.ref('excluded.status'),
            components: eb.ref('excluded.components'),
            body_parameter_count: eb.ref('excluded.body_parameter_count'),
            synced_at: new Date(),
          })),
        )
        .execute();
      upserted++;
    }
    await audit(trx, { legalEntityId, actor, action: 'templates.synced', targetType: 'whatsapp_account', targetId: account.id, metadata: { count: upserted }, requestId });
    return { synced: upserted };
  });
}
