import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/platform/db/database.js';
import { authHeaders, closeAll, makeHarness, ownerQuery, randomWaId, receiveText, seedTemplate, seedTenant } from '../helpers/fixtures.js';

afterAll(closeAll);

describe('marketing consent ledger', () => {
  it('records consent changes append-only with evidence and audit', async () => {
    const h = await makeHarness();
    const t = await seedTenant(h.deps);
    const { customerId } = await receiveText(h, t, randomWaId(), 'hi');
    const agent = await authHeaders(t, 'agent-1', ['agent']);
    const grant = await h.app.inject({
      method: 'POST',
      url: `/v1/customers/${customerId}/consents`,
      headers: agent,
      payload: { purpose: 'marketing', status: 'granted', source: 'store', evidence: 'Signed in-store form #4411' },
    });
    expect(grant.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: `/v1/customers/${customerId}`, headers: agent })).json().marketingConsent).toBe('granted');

    await h.app.inject({ method: 'POST', url: `/v1/customers/${customerId}/consents`, headers: agent, payload: { purpose: 'marketing', status: 'revoked', source: 'agent_recorded', evidence: 'Customer asked by phone' } });
    const ledger = (await h.app.inject({ method: 'GET', url: `/v1/customers/${customerId}/consents`, headers: agent })).json().data;
    expect(ledger.map((r: { status: string }) => r.status)).toEqual(['revoked', 'granted']);
    await expect(ownerQuery('SELECT 1')).resolves.toBeTruthy();
    await expect(withTenant(h.deps.db, t.legalEntityId, (trx) => trx.deleteFrom('consent_records').execute())).rejects.toThrow();
  });

  it('records explicit opt-in via the START keyword', async () => {
    const h = await makeHarness();
    const t = await seedTenant(h.deps);
    const { customerId } = await receiveText(h, t, randomWaId(), 'START');
    const c = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('consent_records').selectAll().where('customer_id', '=', customerId).execute());
    expect(c[0]).toMatchObject({ status: 'granted', source: 'whatsapp_keyword' });
  });
});

describe('campaigns require human approval', () => {
  async function setup() {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const tpl = await seedTemplate(h.deps, t, { name: 'winter_sale', category: 'MARKETING', language: 'ar', bodyText: 'خصم {{1}}' });
    const consenting = await receiveText(h, t, randomWaId(), 'START'); // opt-in keyword grants consent
    const silent = await receiveText(h, t, randomWaId(), 'hello'); // no consent
    const optedOut = await receiveText(h, t, randomWaId(), 'STOP');
    h.graph.calls.length = 0;
    const creator = await authHeaders(t, 'marketer', ['entity_admin', 'campaign_approver']);
    const approver = await authHeaders(t, 'manager', ['campaign_approver']);
    return { h, t, tpl, consenting, silent, optedOut, creator, approver };
  }

  it('cannot be launched without approval and cannot be self-approved', async () => {
    const { h, t, tpl, consenting, creator } = await setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: creator,
      payload: { name: 'Winter', whatsappAccountId: t.accountId, templateId: tpl.id, customerIds: [consenting.customerId], templateParameters: ['20%'] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await h.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/launch`, headers: creator })).statusCode).toBe(409);
    expect((await h.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/submit`, headers: creator })).statusCode).toBe(200);
    const self = await h.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/approve`, headers: creator, payload: {} });
    expect(self.statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/launch`, headers: creator })).statusCode).toBe(409);
    // The database also refuses a self-approval.
    await expect(ownerQuery("UPDATE campaigns SET status = 'approved', decided_by = created_by WHERE id = $1", [id])).rejects.toThrow(/approver_differs_from_creator/);
  });

  it('sends only to consenting, non-opted-out recipients once approved', async () => {
    const { h, t, tpl, consenting, silent, optedOut, creator, approver } = await setup();
    const id = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        headers: creator,
        payload: { name: 'Winter', whatsappAccountId: t.accountId, templateId: tpl.id, customerIds: [consenting.customerId, silent.customerId, optedOut.customerId], templateParameters: ['20%'] },
      })
    ).json().id;
    await h.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/submit`, headers: creator });
    const approved = await h.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/approve`, headers: approver, payload: { note: 'OK for weekend' } });
    expect(approved.json()).toMatchObject({ status: 'approved', decided_by: 'manager' });
    expect((await h.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/launch`, headers: creator })).statusCode).toBe(200);
    await h.drain();

    const recipients = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('campaign_recipients').select(['customer_id', 'status', 'skip_reason']).where('campaign_id', '=', id).execute());
    const byCustomer = Object.fromEntries(recipients.map((r) => [r.customer_id, r]));
    expect(byCustomer[consenting.customerId]).toMatchObject({ status: 'queued' });
    expect(byCustomer[silent.customerId]).toMatchObject({ status: 'skipped', skip_reason: 'marketing_consent_missing' });
    expect(byCustomer[optedOut.customerId]).toMatchObject({ status: 'skipped', skip_reason: 'customer_opted_out' });
    expect(h.graph.messageCalls()).toHaveLength(1);
    const campaign = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('campaigns').select('status').where('id', '=', id).executeTakeFirstOrThrow());
    expect(campaign.status).toBe('completed');
  });

  it('rejects audiences above the configured limit', async () => {
    const { h, t, tpl, creator } = await setup();
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    const res = await h.app.inject({ method: 'POST', url: '/v1/campaigns', headers: creator, payload: { name: 'Too big', whatsappAccountId: t.accountId, templateId: tpl.id, customerIds: ids, templateParameters: ['x'] } });
    expect(res.statusCode).toBe(400);
  });
});
