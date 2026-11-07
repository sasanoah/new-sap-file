import type { Tx } from '../../../platform/db/database.js';
import { notFound, AppError } from '../../../platform/http/errors.js';
import { GraphApiClient } from '../connector/graph-client.js';
import type { WhatsAppDeps } from '../context.js';

export const accessTokenAad = (accountId: string) => `whatsapp_account:${accountId}:access_token`;
export const appSecretAad = (metaAppRowId: string) => `meta_app:${metaAppRowId}:app_secret`;

export async function loadAccount(trx: Tx, accountId: string) {
  const account = await trx.selectFrom('whatsapp_accounts').selectAll().where('id', '=', accountId).executeTakeFirst();
  if (!account) throw notFound('WhatsApp account');
  return account;
}

export async function loadMetaApp(trx: Tx, metaAppRowId: string) {
  const app = await trx.selectFrom('meta_apps').selectAll().where('id', '=', metaAppRowId).executeTakeFirst();
  if (!app) throw notFound('Meta app');
  return app;
}

/** Builds a Graph client for an account. Decrypted tokens never leave this process memory. */
export async function graphClientForAccount(trx: Tx, deps: WhatsAppDeps, accountId: string) {
  const account = await loadAccount(trx, accountId);
  if (!account.access_token_ciphertext) {
    throw new AppError('precondition_failed', 'No access token stored for this WhatsApp account');
  }
  const metaApp = await loadMetaApp(trx, account.meta_app_id);
  const token = deps.secrets.decrypt(account.access_token_ciphertext, accessTokenAad(account.id));
  const client = new GraphApiClient({
    baseUrl: deps.config.graphBaseUrl,
    version: metaApp.graph_api_version,
    accessToken: token,
    timeoutMs: deps.config.graphTimeoutMs,
    fetch: deps.fetch,
  });
  return { account, metaApp, client };
}

/** Public view of an account: never includes secrets. */
export function presentAccount(a: Awaited<ReturnType<typeof loadAccount>>) {
  return {
    id: a.id,
    legalEntityId: a.legal_entity_id,
    wabaId: a.waba_id,
    phoneNumberId: a.phone_number_id,
    displayPhoneNumber: a.display_phone_number,
    status: a.status,
    hasAccessToken: a.access_token_ciphertext !== null,
    accessTokenFingerprint: a.access_token_fingerprint,
    verification: a.verification,
    verifiedAt: a.verified_at,
    sendingEnabled: a.sending_enabled,
    aiAssistantEnabled: a.ai_assistant_enabled,
  };
}
