import { sql } from 'kysely';
import { withPlatform, withTenant } from '../../../platform/db/database.js';
import type { VerificationResult } from '../../../platform/db/schema.js';
import { audit, type Actor } from '../../../platform/audit/audit.js';
import { fingerprint, sha256Hex } from '../../../platform/crypto/secrets.js';
import { AppError, conflict, notFound } from '../../../platform/http/errors.js';
import { GraphApiError } from '../connector/errors.js';
import type { WhatsAppDeps } from '../context.js';
import { accessTokenAad, appSecretAad, graphClientForAccount, loadAccount, presentAccount } from './credentials.js';

const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'];

export async function createLegalEntity(
  deps: WhatsAppDeps,
  input: { code: string; name: string; defaultLocale: 'ar' | 'en'; timezone: string },
  actor: Actor,
  requestId?: string,
) {
  return withPlatform(deps.db, async (trx) => {
    const exists = await trx.selectFrom('legal_entities').select('id').where('code', '=', input.code).executeTakeFirst();
    if (exists) throw conflict('Legal entity code already exists');
    const row = await trx
      .insertInto('legal_entities')
      .values({ code: input.code, name: input.name, default_locale: input.defaultLocale, timezone: input.timezone })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, { legalEntityId: null, actor, action: 'legal_entity.created', targetType: 'legal_entity', targetId: row.id, metadata: { code: row.code }, requestId });
    return row;
  });
}

export async function registerMetaApp(
  deps: WhatsAppDeps,
  input: { metaAppId: string; displayName: string; appSecret: string; verifyToken: string; graphApiVersion: string },
  actor: Actor,
  requestId?: string,
) {
  return withPlatform(deps.db, async (trx) => {
    const exists = await trx.selectFrom('meta_apps').select('id').where('meta_app_id', '=', input.metaAppId).executeTakeFirst();
    if (exists) throw conflict('Meta app already registered');
    const id = crypto.randomUUID();
    const row = await trx
      .insertInto('meta_apps')
      .values({
        id,
        meta_app_id: input.metaAppId,
        display_name: input.displayName,
        app_secret_ciphertext: deps.secrets.encrypt(input.appSecret, appSecretAad(id)),
        verify_token_sha256: sha256Hex(input.verifyToken),
        graph_api_version: input.graphApiVersion,
      })
      .returning(['id', 'meta_app_id', 'display_name', 'graph_api_version'])
      .executeTakeFirstOrThrow();
    await audit(trx, {
      legalEntityId: null,
      actor,
      action: 'meta_app.registered',
      targetType: 'meta_app',
      targetId: row.id,
      metadata: { metaAppId: row.meta_app_id, appSecret: fingerprint(input.appSecret) },
      requestId,
    });
    return row;
  });
}

export async function registerAccount(
  deps: WhatsAppDeps,
  legalEntityId: string,
  input: { metaAppId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string },
  actor: Actor,
  requestId?: string,
) {
  return withTenant(deps.db, legalEntityId, async (trx) => {
    const app = await trx.selectFrom('meta_apps').select('id').where('meta_app_id', '=', input.metaAppId).executeTakeFirst();
    if (!app) throw notFound('Meta app');
    // phone_number_id is globally unique; the routing function sees across tenants.
    const taken = await sql<{ taken: boolean }>`select exists(select 1 from wa_route_phone_number(${input.phoneNumberId})) as taken`.execute(trx);
    if (taken.rows[0]?.taken) throw conflict('Phone number is already registered');
    const row = await trx
      .insertInto('whatsapp_accounts')
      .values({
        legal_entity_id: legalEntityId,
        meta_app_id: app.id,
        waba_id: input.wabaId,
        phone_number_id: input.phoneNumberId,
        display_phone_number: input.displayPhoneNumber,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, { legalEntityId, actor, action: 'whatsapp_account.registered', targetType: 'whatsapp_account', targetId: row.id, metadata: { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId }, requestId });
    return presentAccount(row);
  });
}

/** Stores (or rotates) the access token. Any change resets verification and disables sending. */
export async function setAccessToken(deps: WhatsAppDeps, legalEntityId: string, accountId: string, token: string, actor: Actor, requestId?: string) {
  if (token.trim().length < 20) throw new AppError('bad_request', 'accessToken looks invalid');
  return withTenant(deps.db, legalEntityId, async (trx) => {
    const account = await loadAccount(trx, accountId);
    const row = await trx
      .updateTable('whatsapp_accounts')
      .set({
        access_token_ciphertext: deps.secrets.encrypt(token.trim(), accessTokenAad(account.id)),
        access_token_fingerprint: fingerprint(token.trim()),
        status: 'pending_verification',
        sending_enabled: false,
        verification: null,
        verified_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', account.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, {
      legalEntityId,
      actor,
      action: account.access_token_ciphertext ? 'whatsapp_account.token_rotated' : 'whatsapp_account.token_set',
      targetType: 'whatsapp_account',
      targetId: account.id,
      metadata: { fingerprint: row.access_token_fingerprint },
      requestId,
    });
    return presentAccount(row);
  });
}

/**
 * Checks, live against Meta, that this account can really send:
 * token validity and scopes, phone number ownership and status, and the app's
 * webhook subscription. Only a full pass marks the account 'verified'.
 * It never enables sending; that is a separate platform-admin action.
 */
export async function verifyAccount(deps: WhatsAppDeps, legalEntityId: string, accountId: string, actor: Actor, requestId?: string) {
  const { account, metaApp, client } = await withTenant(deps.db, legalEntityId, (trx) => graphClientForAccount(trx, deps, accountId));
  const checks: VerificationResult['checks'] = [];
  let phoneNumber: Record<string, unknown> | undefined;

  const run = async (name: string, fn: () => Promise<{ passed: boolean; detail?: string }>) => {
    try {
      checks.push({ name, ...(await fn()) });
    } catch (err) {
      const detail = err instanceof GraphApiError ? `${err.message} (code ${err.code ?? err.httpStatus})` : (err as Error).message;
      checks.push({ name, passed: false, detail });
    }
  };

  const appSecret = deps.secrets.decrypt(metaApp.app_secret_ciphertext, appSecretAad(metaApp.id));
  await run('token_valid_with_scopes', async () => {
    const info = await client.debugToken(`${metaApp.meta_app_id}|${appSecret}`);
    if (!info.is_valid) return { passed: false, detail: info.error?.message ?? 'token is not valid' };
    if (info.app_id && info.app_id !== metaApp.meta_app_id) return { passed: false, detail: 'token belongs to a different Meta app' };
    const scopes = new Set(info.scopes ?? []);
    const missing = REQUIRED_SCOPES.filter((s) => !scopes.has(s));
    if (missing.length) return { passed: false, detail: `missing scopes: ${missing.join(', ')}` };
    const granular = info.granular_scopes?.find((g) => g.scope === 'whatsapp_business_messaging');
    if (granular?.target_ids && !granular.target_ids.includes(account.waba_id)) {
      return { passed: false, detail: 'token is not granted messaging on this WABA' };
    }
    return { passed: true, detail: info.expires_at ? `expires_at=${info.expires_at}` : 'non-expiring' };
  });
  await run('phone_number_in_waba', async () => {
    const numbers = await client.listPhoneNumbers(account.waba_id);
    return numbers.some((n) => n.id === account.phone_number_id)
      ? { passed: true }
      : { passed: false, detail: 'phone_number_id is not part of this WABA' };
  });
  await run('phone_number_status', async () => {
    const info = await client.getPhoneNumber(account.phone_number_id);
    phoneNumber = { ...info };
    const problems: string[] = [];
    if (info.status && !['CONNECTED', 'ONLINE'].includes(info.status.toUpperCase())) problems.push(`status=${info.status}`);
    if (info.name_status && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(info.name_status.toUpperCase())) problems.push(`name_status=${info.name_status}`);
    if (info.quality_rating && info.quality_rating.toUpperCase() === 'RED') problems.push('quality_rating=RED');
    return problems.length ? { passed: false, detail: problems.join(', ') } : { passed: true, detail: `${info.verified_name ?? ''} ${info.display_phone_number ?? ''}`.trim() };
  });
  await run('app_subscribed_to_waba', async () => {
    const apps = await client.getSubscribedApps(account.waba_id);
    return apps.some((a) => a.whatsapp_business_api_data?.id === metaApp.meta_app_id)
      ? { passed: true }
      : { passed: false, detail: 'Meta app is not subscribed to this WABA’s webhooks' };
  });

  const result: VerificationResult = { checkedAt: deps.clock.now().toISOString(), passed: checks.every((c) => c.passed), checks, phoneNumber };
  return withTenant(deps.db, legalEntityId, async (trx) => {
    const row = await trx
      .updateTable('whatsapp_accounts')
      .set({
        status: result.passed ? 'verified' : 'verification_failed',
        verification: JSON.stringify(result) as never,
        verified_at: result.passed ? new Date() : null,
        ...(result.passed ? {} : { sending_enabled: false }),
        updated_at: new Date(),
      })
      .where('id', '=', account.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, {
      legalEntityId,
      actor,
      action: result.passed ? 'whatsapp_account.verified' : 'whatsapp_account.verification_failed',
      targetType: 'whatsapp_account',
      targetId: account.id,
      metadata: { checks },
      requestId,
    });
    return presentAccount(row);
  });
}

export async function setSendingEnabled(deps: WhatsAppDeps, legalEntityId: string, accountId: string, enabled: boolean, actor: Actor, requestId?: string) {
  return withTenant(deps.db, legalEntityId, async (trx) => {
    const account = await loadAccount(trx, accountId);
    if (enabled && account.status !== 'verified') {
      throw new AppError('precondition_failed', 'Account must pass verification before sending can be enabled');
    }
    const row = await trx.updateTable('whatsapp_accounts').set({ sending_enabled: enabled, updated_at: new Date() }).where('id', '=', account.id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, {
      legalEntityId,
      actor,
      action: enabled ? 'whatsapp_account.sending_enabled' : 'whatsapp_account.sending_disabled',
      targetType: 'whatsapp_account',
      targetId: account.id,
      metadata: { outboundMode: deps.config.outboundMode },
      requestId,
    });
    return presentAccount(row);
  });
}

export async function setAiAssistantEnabled(deps: WhatsAppDeps, legalEntityId: string, accountId: string, enabled: boolean, actor: Actor, requestId?: string) {
  return withTenant(deps.db, legalEntityId, async (trx) => {
    if (enabled && !deps.ai) throw new AppError('precondition_failed', 'No AI provider is configured (ANTHROPIC_API_KEY)');
    const account = await loadAccount(trx, accountId);
    const row = await trx.updateTable('whatsapp_accounts').set({ ai_assistant_enabled: enabled, updated_at: new Date() }).where('id', '=', account.id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, { legalEntityId, actor, action: enabled ? 'ai_assistant.enabled' : 'ai_assistant.disabled', targetType: 'whatsapp_account', targetId: account.id, requestId });
    return presentAccount(row);
  });
}
