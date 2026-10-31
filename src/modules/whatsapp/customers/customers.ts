import type { Tx } from '../../../platform/db/database.js';
import type { ConsentSource, Locale } from '../../../platform/db/schema.js';
import { audit, type Actor } from '../../../platform/audit/audit.js';
import { emit } from '../../../platform/events/outbox.js';
import type { ConsentState } from '../compliance/policy.js';

export async function upsertCustomerByWaId(
  trx: Tx,
  legalEntityId: string,
  input: { waId: string; profileName?: string | null; locale?: Locale | null },
) {
  const row = await trx
    .insertInto('customers')
    .values({
      legal_entity_id: legalEntityId,
      wa_id: input.waId,
      profile_name: input.profileName ?? null,
      preferred_locale: input.locale ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['legal_entity_id', 'wa_id']).doUpdateSet((eb) => ({
        // Keep the latest WhatsApp profile name; only fill locale if still unknown.
        profile_name: eb.fn.coalesce(eb.ref('excluded.profile_name'), eb.ref('customers.profile_name')),
        preferred_locale: eb.fn.coalesce(eb.ref('customers.preferred_locale'), eb.ref('excluded.preferred_locale')),
        updated_at: new Date(),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row;
}

export async function getMarketingConsent(trx: Tx, customerId: string): Promise<ConsentState> {
  const latest = await trx
    .selectFrom('consent_records')
    .select('status')
    .where('customer_id', '=', customerId)
    .where('purpose', '=', 'marketing')
    .orderBy('recorded_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return latest?.status ?? 'none';
}

export interface ConsentInput {
  legalEntityId: string;
  customerId: string;
  status: 'granted' | 'revoked';
  source: ConsentSource;
  evidence: string;
  actor: Actor;
  requestId?: string | null;
}

/** Appends to the consent ledger (never updates) and audits it. */
export async function recordMarketingConsent(trx: Tx, input: ConsentInput) {
  const recordedByType = input.actor.type === 'user' ? 'agent' : input.actor.type === 'customer' ? 'customer' : 'system';
  const row = await trx
    .insertInto('consent_records')
    .values({
      legal_entity_id: input.legalEntityId,
      customer_id: input.customerId,
      purpose: 'marketing',
      status: input.status,
      source: input.source,
      evidence: input.evidence,
      recorded_by_type: recordedByType,
      recorded_by_id: input.actor.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(trx, {
    legalEntityId: input.legalEntityId,
    actor: input.actor,
    action: `consent.marketing.${input.status}`,
    targetType: 'customer',
    targetId: input.customerId,
    metadata: { source: input.source, consentRecordId: row.id },
    requestId: input.requestId,
  });
  await emit(trx, input.legalEntityId, 'whatsapp.consent.changed', {
    customerId: input.customerId,
    purpose: 'marketing',
    status: input.status,
    source: input.source,
  });
  return row;
}

/** Opt-out blocks every business-initiated message and revokes marketing consent. */
export async function optOutCustomer(
  trx: Tx,
  input: { legalEntityId: string; customerId: string; at: Date; source: ConsentSource; evidence: string; actor: Actor },
) {
  await trx
    .updateTable('customers')
    .set({ opted_out_at: input.at, updated_at: new Date() })
    .where('id', '=', input.customerId)
    .execute();
  await recordMarketingConsent(trx, { ...input, status: 'revoked' });
  await audit(trx, {
    legalEntityId: input.legalEntityId,
    actor: input.actor,
    action: 'customer.opted_out',
    targetType: 'customer',
    targetId: input.customerId,
    metadata: { source: input.source },
  });
}

/** Explicit opt-in (e.g. the customer sent START): clears the opt-out and records consent. */
export async function optInCustomer(
  trx: Tx,
  input: { legalEntityId: string; customerId: string; source: ConsentSource; evidence: string; actor: Actor },
) {
  await trx
    .updateTable('customers')
    .set({ opted_out_at: null, updated_at: new Date() })
    .where('id', '=', input.customerId)
    .execute();
  await recordMarketingConsent(trx, { ...input, status: 'granted' });
}
