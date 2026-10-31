import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/platform/db/database.js';
import { authHeaders, closeAll, makeHarness, ownerQuery, randomWaId, receiveText, seedTenant, token, type Harness, type Tenant } from '../helpers/fixtures.js';

let h: Harness;
let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  h = await makeHarness();
  a = await seedTenant(h.deps, { name: 'Bed Janssen' });
  b = await seedTenant(h.deps, { name: 'Sister Company', metaApp: a }); // shares the Meta app
});
afterAll(closeAll);

describe('legal-entity isolation', () => {
  it('routes each phone number on a shared Meta app to its own tenant', async () => {
    const waId = randomWaId();
    await receiveText(h, a, waId, 'to A');
    await receiveText(h, b, waId, 'to B');
    const aMsgs = await withTenant(h.deps.db, a.legalEntityId, (trx) => trx.selectFrom('messages').select('text_body').execute());
    const bMsgs = await withTenant(h.deps.db, b.legalEntityId, (trx) => trx.selectFrom('messages').select('text_body').execute());
    expect(aMsgs.map((m) => m.text_body)).toEqual(['to A']);
    expect(bMsgs.map((m) => m.text_body)).toEqual(['to B']);
  });

  it('row-level security hides other tenants and rejects cross-tenant writes', async () => {
    const { customerId } = await receiveText(h, a, randomWaId(), 'secret');
    const fromB = await withTenant(h.deps.db, b.legalEntityId, (trx) => trx.selectFrom('customers').select('id').where('id', '=', customerId).execute());
    expect(fromB).toHaveLength(0);
    await expect(
      withTenant(h.deps.db, b.legalEntityId, (trx) =>
        trx.insertInto('customers').values({ legal_entity_id: a.legalEntityId, wa_id: randomWaId() }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // Without a tenant context the app role sees nothing at all.
    const none = await h.deps.db.selectFrom('messages').select('id').execute();
    expect(none).toHaveLength(0);
  });

  it('the API refuses tenants not in the token and hides other tenants’ records', async () => {
    const { conversationId } = await receiveText(h, a, randomWaId(), 'hello');
    const asB = await authHeaders(b, 'agent-b', ['agent']);
    expect((await h.app.inject({ method: 'GET', url: `/v1/inbox/conversations/${conversationId}`, headers: asB })).statusCode).toBe(404);

    // Token for B, header claiming A.
    const spoof = { ...asB, 'x-legal-entity-id': a.legalEntityId };
    expect((await h.app.inject({ method: 'GET', url: '/v1/inbox/conversations', headers: spoof })).statusCode).toBe(403);

    const asA = await authHeaders(a, 'agent-a', ['agent']);
    const ok = await h.app.inject({ method: 'GET', url: `/v1/inbox/conversations/${conversationId}`, headers: asA });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects missing, invalid and wrongly-signed tokens', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/inbox/conversations' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/inbox/conversations', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    const noRoles = { authorization: `Bearer ${await token({ sub: 'x' })}`, 'x-legal-entity-id': a.legalEntityId };
    expect((await h.app.inject({ method: 'GET', url: '/v1/inbox/conversations', headers: noRoles })).statusCode).toBe(403);
  });

  it('keeps the audit log append-only for the application role', async () => {
    await receiveText(h, a, randomWaId(), 'x');
    await expect(withTenant(h.deps.db, a.legalEntityId, (trx) => trx.updateTable('audit_log').set({ action: 'tampered' }).execute())).rejects.toThrow();
    await expect(withTenant(h.deps.db, a.legalEntityId, (trx) => trx.deleteFrom('audit_log').execute())).rejects.toThrow();
    await expect(ownerQuery('UPDATE audit_log SET action = $1', ['tampered'])).rejects.toThrow(/append-only/);
  });
});
