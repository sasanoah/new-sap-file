import { sql } from 'kysely';
import { withTenant, type Db } from '../../../platform/db/database.js';
import { constantTimeEqual, sha256Hex } from '../../../platform/crypto/secrets.js';
import { enqueue } from '../../../platform/events/jobs.js';
import type { WhatsAppDeps } from '../context.js';
import { appSecretAad } from '../accounts/credentials.js';
import { isValidSignature } from './signature.js';
import { canonicalJson, WebhookEnvelopeSchema } from './payload.js';

export type IngestResult =
  | { ok: true; stored: number; duplicates: number; unroutable: number; ignored: number }
  | { ok: false; status: 401 | 404 | 400; reason: string };

interface Route {
  legal_entity_id: string;
  whatsapp_account_id: string;
  meta_app_id: string;
}

async function routesFor(db: Db, field: string, entryId: string, value: Record<string, unknown>): Promise<{ key: string | null; routes: Route[] }> {
  if (field === 'messages') {
    const phoneNumberId = (value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id;
    if (typeof phoneNumberId !== 'string') return { key: null, routes: [] };
    const r = await sql<Route>`select * from wa_route_phone_number(${phoneNumberId})`.execute(db);
    return { key: phoneNumberId, routes: r.rows };
  }
  if (field === 'message_template_status_update' || field === 'message_template_quality_update') {
    const r = await sql<Route>`select * from wa_route_waba(${entryId})`.execute(db);
    // A WABA belongs to one legal entity; templates are stored per phone number.
    return { key: entryId, routes: r.rows };
  }
  return { key: null, routes: [] };
}

/** Handles the GET verification handshake Meta performs when the webhook URL is configured. */
export async function verifySubscription(
  db: Db,
  metaAppId: string,
  query: Record<string, unknown>,
): Promise<{ ok: true; challenge: string } | { ok: false }> {
  if (query['hub.mode'] !== 'subscribe') return { ok: false };
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (typeof token !== 'string' || typeof challenge !== 'string') return { ok: false };
  const app = await db.selectFrom('meta_apps').select('verify_token_sha256').where('meta_app_id', '=', metaAppId).executeTakeFirst();
  if (!app || !constantTimeEqual(sha256Hex(token), app.verify_token_sha256)) return { ok: false };
  return { ok: true, challenge };
}

/**
 * Authenticates and persists a webhook delivery. Nothing is processed here:
 * each change is stored once per tenant (deduplicated by content hash) and a
 * job is enqueued, so we can answer Meta quickly and retry processing safely.
 */
export async function ingestWebhook(deps: WhatsAppDeps, metaAppId: string, rawBody: Buffer, signature: string | undefined): Promise<IngestResult> {
  const app = await deps.db.selectFrom('meta_apps').selectAll().where('meta_app_id', '=', metaAppId).executeTakeFirst();
  if (!app) return { ok: false, status: 404, reason: 'unknown_app' };
  const appSecret = deps.secrets.decrypt(app.app_secret_ciphertext, appSecretAad(app.id));
  if (!isValidSignature(rawBody, signature, appSecret)) return { ok: false, status: 401, reason: 'invalid_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, status: 400, reason: 'invalid_json' };
  }
  const envelope = WebhookEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    deps.log.warn({ metaAppId }, 'ignoring signed webhook with unexpected shape');
    return { ok: true, stored: 0, duplicates: 0, unroutable: 0, ignored: 1 };
  }

  let stored = 0;
  let duplicates = 0;
  let unroutable = 0;
  let ignored = 0;

  for (const entry of envelope.data.entry) {
    for (const change of entry.changes) {
      const { key, routes } = await routesFor(deps.db, change.field, entry.id, change.value);
      if (key === null) {
        ignored++;
        continue;
      }
      // The signing app must be the app the number is registered under; otherwise
      // one tenant's Meta app could inject events into another tenant.
      const valid = routes.filter((r) => r.meta_app_id === metaAppId);
      const hash = sha256Hex(canonicalJson({ field: change.field, entry: entry.id, value: change.value }));
      if (valid.length === 0) {
        await deps.db
          .insertInto('unroutable_webhook_events')
          .values({ meta_app_id: metaAppId, phone_number_id: key, payload_sha256: hash })
          .execute();
        deps.log.warn({ metaAppId, key }, 'unroutable webhook change');
        unroutable++;
        continue;
      }
      for (const route of valid) {
        const inserted = await withTenant(deps.db, route.legal_entity_id, async (trx) => {
          const row = await trx
            .insertInto('webhook_events')
            .values({
              legal_entity_id: route.legal_entity_id,
              whatsapp_account_id: route.whatsapp_account_id,
              field: change.field,
              dedupe_key: `${route.whatsapp_account_id}:${hash}`,
              payload: JSON.stringify({ entryId: entry.id, value: change.value }) as never,
            })
            .onConflict((oc) => oc.columns(['legal_entity_id', 'dedupe_key']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (row) await enqueue(trx, { legalEntityId: route.legal_entity_id, kind: 'webhook_event', refId: row.id });
          return Boolean(row);
        });
        if (inserted) stored++;
        else duplicates++;
      }
    }
  }
  return { ok: true, stored, duplicates, unroutable, ignored };
}
