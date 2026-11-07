import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/platform/db/database.js';
import { signBody } from '../../src/modules/whatsapp/webhook/signature.js';
import { closeAll, inboundTextPayload, makeHarness, ownerQuery, postWebhook, randomWaId, receiveText, seedTenant, type Harness, type Tenant } from '../helpers/fixtures.js';

let h: Harness;
let t: Tenant;

beforeEach(async () => {
  h = await makeHarness();
  t = await seedTenant(h.deps);
});
afterAll(closeAll);

describe('webhook verification handshake', () => {
  it('echoes hub.challenge for the right verify token', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/webhooks/whatsapp/${t.metaAppId}?hub.mode=subscribe&hub.verify_token=${t.verifyToken}&hub.challenge=12345` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('12345');
  });
  it('rejects a wrong token or unknown app', async () => {
    expect((await h.app.inject({ method: 'GET', url: `/webhooks/whatsapp/${t.metaAppId}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1` })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: `/webhooks/whatsapp/999?hub.mode=subscribe&hub.verify_token=${t.verifyToken}&hub.challenge=1` })).statusCode).toBe(403);
  });
});

describe('webhook signature', () => {
  it('rejects unsigned or mis-signed deliveries and stores nothing', async () => {
    const payload = inboundTextPayload(t, { from: randomWaId(), text: 'hi' });
    const body = JSON.stringify(payload);
    expect((await postWebhook(h, t, payload, signBody(body, 'wrong-secret'))).statusCode).toBe(401);
    expect((await postWebhook(h, t, payload, 'sha256=00')).statusCode).toBe(401);
    const res = await h.app.inject({ method: 'POST', url: `/webhooks/whatsapp/${t.metaAppId}`, headers: { 'content-type': 'application/json' }, payload: body });
    expect(res.statusCode).toBe(401);
    const count = await ownerQuery<{ n: string }>('SELECT count(*) n FROM webhook_events WHERE legal_entity_id = $1', [t.legalEntityId]);
    expect(count.rows[0]!.n).toBe('0');
  });

  it('does not route a number to a tenant when signed by a different Meta app', async () => {
    const other = await seedTenant(h.deps); // has its own Meta app
    const payload = inboundTextPayload(t, { from: randomWaId(), text: 'spoof' });
    const res = await postWebhook(h, other, payload); // valid signature, but for other's app
    expect(res.statusCode).toBe(200);
    const stored = await ownerQuery<{ n: string }>('SELECT count(*) n FROM webhook_events WHERE legal_entity_id = $1', [t.legalEntityId]);
    expect(stored.rows[0]!.n).toBe('0');
    const unroutable = await ownerQuery<{ n: string }>('SELECT count(*) n FROM unroutable_webhook_events WHERE meta_app_id = $1', [other.metaAppId]);
    expect(unroutable.rows[0]!.n).toBe('1');
  });
});

describe('incoming messages', () => {
  it('identifies the customer, opens a conversation and records history', async () => {
    const waId = randomWaId();
    const { conversationId, customerId } = await receiveText(h, t, waId, 'السلام عليكم، أبي أسأل عن المراتب');

    await withTenant(h.deps.db, t.legalEntityId, async (trx) => {
      const customer = await trx.selectFrom('customers').selectAll().where('id', '=', customerId).executeTakeFirstOrThrow();
      expect(customer).toMatchObject({ wa_id: waId, profile_name: 'Customer', preferred_locale: 'ar', opted_out_at: null });
      const conv = await trx.selectFrom('conversations').selectAll().where('id', '=', conversationId).executeTakeFirstOrThrow();
      expect(conv.handling_mode).toBe('human_queue');
      expect(conv.service_window_expires_at!.getTime() - conv.last_inbound_at!.getTime()).toBe(24 * 3600_000);
      const msgs = await trx.selectFrom('messages').selectAll().where('conversation_id', '=', conversationId).execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ direction: 'inbound', status: 'received', text_body: 'السلام عليكم، أبي أسأل عن المراتب' });
      const events = await trx.selectFrom('outbox_events').select('topic').execute();
      expect(events.map((e) => e.topic)).toContain('whatsapp.message.received');
      const audits = await trx.selectFrom('audit_log').select('action').execute();
      expect(audits.map((a) => a.action)).toContain('message.inbound.received');
    });

    // A second message lands in the same conversation.
    await receiveText(h, t, waId, 'Do you deliver to Jeddah?');
    const n = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('messages').select('id').where('conversation_id', '=', conversationId).execute());
    expect(n).toHaveLength(2);
  });

  it('is idempotent across Meta retries and duplicate wamids', async () => {
    const waId = randomWaId();
    const payload = inboundTextPayload(t, { from: waId, text: 'hello', wamid: 'wamid.DUP1', timestamp: h.clock.now() });
    expect((await postWebhook(h, t, payload)).statusCode).toBe(200);
    expect((await postWebhook(h, t, payload)).statusCode).toBe(200); // exact retry
    // Same message delivered again with different envelope metadata.
    const variant = structuredClone(payload);
    (variant.entry[0]!.changes[0]!.value.contacts[0]!.profile as { name: string }).name = 'Renamed';
    expect((await postWebhook(h, t, variant)).statusCode).toBe(200);
    await h.drain();

    const events = await ownerQuery<{ n: string }>('SELECT count(*) n FROM webhook_events WHERE legal_entity_id = $1', [t.legalEntityId]);
    expect(events.rows[0]!.n).toBe('2');
    const msgs = await ownerQuery<{ n: string }>("SELECT count(*) n FROM messages WHERE legal_entity_id = $1 AND wamid = 'wamid.DUP1'", [t.legalEntityId]);
    expect(msgs.rows[0]!.n).toBe('1');
  });

  it('keeps the service window anchored to the newest message when deliveries arrive out of order', async () => {
    const waId = randomWaId();
    const now = h.clock.now();
    await receiveText(h, t, waId, 'second', { timestamp: now });
    const { conversationId } = await receiveText(h, t, waId, 'first', { timestamp: new Date(now.getTime() - 3600_000) });
    const conv = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('conversations').selectAll().where('id', '=', conversationId).executeTakeFirstOrThrow());
    expect(conv.last_inbound_at!.getTime()).toBe(Math.floor(now.getTime() / 1000) * 1000);
  });

  it('updates template status from webhooks', async () => {
    const { seedTemplate } = await import('../helpers/fixtures.js');
    const tpl = await seedTemplate(h.deps, t, { name: 'order_update', status: 'APPROVED' });
    const res = await postWebhook(h, t, {
      object: 'whatsapp_business_account',
      entry: [{ id: t.wabaId, changes: [{ field: 'message_template_status_update', value: { event: 'PAUSED', message_template_id: 1, message_template_name: 'order_update', message_template_language: 'ar', reason: 'LOW_QUALITY' } }] }],
    });
    expect(res.statusCode).toBe(200);
    await h.drain();
    const row = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('message_templates').select('status').where('id', '=', tpl.id).executeTakeFirstOrThrow());
    expect(row.status).toBe('PAUSED');
  });
});
