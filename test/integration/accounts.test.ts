import { afterAll, describe, expect, it } from 'vitest';
import { json } from '../helpers/fake-graph.js';
import { closeAll, makeHarness, ownerQuery, seedTenant, token, type Harness } from '../helpers/fixtures.js';

afterAll(closeAll);

async function platformAdmin() {
  return { authorization: `Bearer ${await token({ sub: 'platform-admin', platformRoles: ['platform_admin'] })}` };
}

/** Walks through onboarding a new legal entity via the API, the way operators will. */
async function onboard(h: Harness) {
  const pa = await platformAdmin();
  const le = await h.app.inject({ method: 'POST', url: '/v1/platform/legal-entities', headers: pa, payload: { code: `bj-${Date.now()}`, name: 'Bed Janssen', defaultLocale: 'ar' } });
  expect(le.statusCode).toBe(201);
  const legalEntityId = le.json().id as string;
  const metaAppId = String(Date.now()).padEnd(15, '7');
  const app = await h.app.inject({
    method: 'POST',
    url: '/v1/platform/meta-apps',
    headers: pa,
    payload: { metaAppId, displayName: 'Group AI OS', appSecret: 'a'.repeat(32), verifyToken: 'v'.repeat(32), graphApiVersion: 'v23.0' },
  });
  expect(app.statusCode).toBe(201);
  expect(JSON.stringify(app.json())).not.toContain('aaaaaaaa');

  const admin = {
    authorization: `Bearer ${await token({ sub: 'bj-admin', legalEntities: { [legalEntityId]: ['entity_admin'] } })}`,
    'x-legal-entity-id': legalEntityId,
  };
  const phoneNumberId = String(Date.now()).padEnd(15, '3');
  const wabaId = String(Date.now()).padEnd(15, '5');
  const acct = await h.app.inject({ method: 'POST', url: '/v1/whatsapp/accounts', headers: admin, payload: { metaAppId, wabaId, phoneNumberId, displayPhoneNumber: '+966 50 123 4567' } });
  expect(acct.statusCode).toBe(201);
  expect(acct.json()).toMatchObject({ status: 'pending_credentials', sendingEnabled: false, hasAccessToken: false });
  return { legalEntityId, metaAppId, phoneNumberId, wabaId, admin, accountId: acct.json().id as string };
}

function healthyMeta(h: Harness, ids: { metaAppId: string; phoneNumberId: string; wabaId: string }) {
  h.graph
    .on('GET /debug_token', () => json(200, { data: { is_valid: true, app_id: ids.metaAppId, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: [ids.wabaId] }] } }))
    .on(`GET /${ids.wabaId}/phone_numbers`, () => json(200, { data: [{ id: ids.phoneNumberId }] }))
    .on(`GET /${ids.phoneNumberId}?`, () => json(200, { id: ids.phoneNumberId, display_phone_number: '+966 50 123 4567', verified_name: 'Bed Janssen', status: 'CONNECTED', name_status: 'APPROVED', quality_rating: 'GREEN' }))
    .on(`GET /${ids.wabaId}/subscribed_apps`, () => json(200, { data: [{ whatsapp_business_api_data: { id: ids.metaAppId } }] }));
}

describe('credential management and production activation gates', () => {
  it('stores tokens encrypted and never returns them', async () => {
    const h = await makeHarness();
    const o = await onboard(h);
    const secret = 'EAAG-real-looking-token-abcdefghijklmnop';
    const res = await h.app.inject({ method: 'PUT', url: `/v1/whatsapp/accounts/${o.accountId}/credentials`, headers: o.admin, payload: { accessToken: secret } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(secret);
    expect(res.json()).toMatchObject({ hasAccessToken: true, status: 'pending_verification', accessTokenFingerprint: expect.stringMatching(/^sha256:/) });
    const raw = await ownerQuery<{ access_token_ciphertext: string }>('SELECT access_token_ciphertext FROM whatsapp_accounts WHERE id = $1', [o.accountId]);
    expect(raw.rows[0]!.access_token_ciphertext).not.toContain('EAAG');
    const audit = await ownerQuery<{ metadata: unknown }>("SELECT metadata FROM audit_log WHERE action = 'whatsapp_account.token_set' AND target_id = $1", [o.accountId]);
    expect(JSON.stringify(audit.rows)).not.toContain(secret);
  });

  it('verifies against Meta, and only a platform admin can then enable sending', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const o = await onboard(h);
    await h.app.inject({ method: 'PUT', url: `/v1/whatsapp/accounts/${o.accountId}/credentials`, headers: o.admin, payload: { accessToken: 'EAAG-real-looking-token-abcdefghijklmnop' } });

    // Cannot enable sending before verification, even as platform admin.
    const pa = { ...(await platformAdmin()), 'x-legal-entity-id': o.legalEntityId };
    const paWithEntity = { authorization: `Bearer ${await token({ sub: 'platform-admin', platformRoles: ['platform_admin'], legalEntities: { [o.legalEntityId]: ['entity_admin'] } })}`, 'x-legal-entity-id': o.legalEntityId };
    expect((await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${o.accountId}/sending`, headers: paWithEntity, payload: { enabled: true } })).statusCode).toBe(412);
    expect((await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${o.accountId}/sending`, headers: pa, payload: { enabled: true } })).statusCode).toBe(403);

    healthyMeta(h, o);
    const verified = await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${o.accountId}/verify`, headers: o.admin });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: 'verified', sendingEnabled: false, verification: { passed: true } });
    expect(h.graph.calls.find((c) => c.path.startsWith('/debug_token'))!.authorization).toBe(`Bearer ${o.metaAppId}|${'a'.repeat(32)}`);

    // Entity admins cannot flip production sending on by themselves.
    expect((await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${o.accountId}/sending`, headers: o.admin, payload: { enabled: true } })).statusCode).toBe(403);
    const enabled = await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${o.accountId}/sending`, headers: paWithEntity, payload: { enabled: true } });
    expect(enabled.json()).toMatchObject({ sendingEnabled: true });
    // Disabling is allowed for entity admins (safe direction).
    expect((await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${o.accountId}/sending`, headers: o.admin, payload: { enabled: false } })).json().sendingEnabled).toBe(false);
  });

  it('fails verification with actionable details when scopes or subscription are missing', async () => {
    const h = await makeHarness();
    const o = await onboard(h);
    await h.app.inject({ method: 'PUT', url: `/v1/whatsapp/accounts/${o.accountId}/credentials`, headers: o.admin, payload: { accessToken: 'EAAG-real-looking-token-abcdefghijklmnop' } });
    healthyMeta(h, o);
    h.graph
      .on('GET /debug_token', () => json(200, { data: { is_valid: true, app_id: o.metaAppId, scopes: ['whatsapp_business_management'] } }))
      .on(`GET /${o.wabaId}/subscribed_apps`, () => json(200, { data: [] }));
    const res = await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${o.accountId}/verify`, headers: o.admin });
    const body = res.json();
    expect(body.status).toBe('verification_failed');
    const failed = body.verification.checks.filter((c: { passed: boolean }) => !c.passed).map((c: { name: string; detail: string }) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([
      'token_valid_with_scopes: missing scopes: whatsapp_business_messaging',
      'app_subscribed_to_waba: Meta app is not subscribed to this WABA’s webhooks',
    ]);
  });

  it('syncs templates from Meta into the registry', async () => {
    const h = await makeHarness();
    const t = await seedTenant(h.deps);
    h.graph.on(`GET /${t.wabaId}/message_templates`, () =>
      json(200, { data: [
        { id: '1', name: 'order_ready', language: 'ar', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'طلبك {{1}} جاهز' }] },
        { id: '2', name: 'promo', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Sale' }] },
      ] }),
    );
    const { authHeaders } = await import('../helpers/fixtures.js');
    const admin = await authHeaders(t, 'adm', ['entity_admin']);
    const res = await h.app.inject({ method: 'POST', url: `/v1/whatsapp/accounts/${t.accountId}/templates/sync`, headers: admin });
    expect(res.json()).toEqual({ synced: 2 });
    const list = (await h.app.inject({ method: 'GET', url: '/v1/whatsapp/templates', headers: admin })).json().data;
    expect(list.map((x: { name: string; body_parameter_count: number }) => [x.name, x.body_parameter_count])).toEqual([['order_ready', 1], ['promo', 0]]);
  });

  it('restricts platform endpoints to platform admins', async () => {
    const h = await makeHarness();
    const t = await seedTenant(h.deps);
    const { authHeaders } = await import('../helpers/fixtures.js');
    const res = await h.app.inject({ method: 'POST', url: '/v1/platform/legal-entities', headers: await authHeaders(t, 'adm', ['entity_admin']), payload: { code: 'x-y', name: 'X' } });
    expect(res.statusCode).toBe(403);
  });
});
