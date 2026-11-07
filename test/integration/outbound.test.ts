import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/platform/db/database.js';
import { json } from '../helpers/fake-graph.js';
import { authHeaders, closeAll, makeHarness, ownerQuery, postWebhook, randomWaId, receiveText, seedTemplate, seedTenant, statusPayload, type Harness, type Tenant } from '../helpers/fixtures.js';

afterAll(closeAll);

const sendText = async (h: Harness, t: Tenant, conversationId: string, text: string, key: string = crypto.randomUUID()) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/inbox/conversations/${conversationId}/messages`,
    headers: await authHeaders(t, 'agent-1', ['agent']),
    payload: { idempotencyKey: key, text },
  });

const messageRow = (h: Harness, t: Tenant, id: string) =>
  withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow());

describe('outbound gates (no production sending by default)', () => {
  it('records but never sends when outbound mode is disabled', async () => {
    const h = await makeHarness({ outboundMode: 'disabled' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    const res = await sendText(h, t, conversationId, 'Hello!');
    expect(res.statusCode).toBe(202);
    expect(res.json().message).toMatchObject({ status: 'blocked', statusReason: 'outbound_disabled' });
    await h.drain();
    expect(h.graph.calls).toHaveLength(0);
  });

  it('dry run passes policy, records the message, and never calls Meta', async () => {
    const h = await makeHarness({ outboundMode: 'dry_run' });
    const t = await seedTenant(h.deps); // unverified account
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    const res = await sendText(h, t, conversationId, 'Hello!');
    expect(res.json().message.status).toBe('dry_run');
    await h.drain();
    expect(h.graph.calls).toHaveLength(0);
  });

  it('live mode still blocks an account that has not been verified and enabled', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'unverified' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    const res = await sendText(h, t, conversationId, 'Hello!');
    expect(res.json().message).toMatchObject({ status: 'blocked', statusReason: 'account_not_enabled' });
    await h.drain();
    expect(h.graph.calls).toHaveLength(0);
  });
});

describe('24-hour window and templates', () => {
  it('rejects free-form text after 24h with 422, but allows an approved template', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    await seedTemplate(h.deps, t, { name: 'followup', language: 'ar', bodyText: 'مرحباً {{1}}' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    h.clock.advance(25 * 3600_000);

    const text = await sendText(h, t, conversationId, 'Are you still there?');
    expect(text.statusCode).toBe(422);
    expect(text.json().error).toMatchObject({ code: 'policy_violation', details: { reason: 'outside_service_window' } });

    const headers = await authHeaders(t, 'agent-1', ['agent']);
    const tpl = await h.app.inject({
      method: 'POST',
      url: `/v1/inbox/conversations/${conversationId}/messages`,
      headers,
      payload: { idempotencyKey: crypto.randomUUID(), template: { name: 'followup', language: 'ar', parameters: ['سارة'] } },
    });
    expect(tpl.statusCode).toBe(202);
    await h.drain();
    const call = h.graph.messageCalls()[0]!;
    expect(call.body).toMatchObject({
      messaging_product: 'whatsapp',
      type: 'template',
      template: { name: 'followup', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'سارة' }] }] },
    });
  });

  it('blocks marketing templates sent directly by agents', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    await seedTemplate(h.deps, t, { name: 'promo', category: 'MARKETING', bodyText: 'Sale!' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/inbox/conversations/${conversationId}/messages`,
      headers: await authHeaders(t, 'agent-1', ['agent']),
      payload: { idempotencyKey: crypto.randomUUID(), template: { name: 'promo', language: 'ar', parameters: [] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.reason).toBe('marketing_requires_approved_campaign');
    const audit = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('audit_log').select('action').where('action', '=', 'message.outbound.blocked').execute());
    expect(audit).toHaveLength(1);
  });
});

describe('live sending, idempotency and status tracking', () => {
  it('sends once per idempotency key and tracks sent → delivered → read', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const waId = randomWaId();
    const { conversationId } = await receiveText(h, t, waId, 'hi');

    const first = await sendText(h, t, conversationId, 'أهلاً بك', 'key-12345678');
    const again = await sendText(h, t, conversationId, 'أهلاً بك', 'key-12345678');
    expect(first.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ duplicate: true, message: { id: first.json().message.id } });
    await h.drain();

    expect(h.graph.messageCalls()).toHaveLength(1);
    const call = h.graph.messageCalls()[0]!;
    expect(call.path).toBe(`/${t.phoneNumberId}/messages`);
    expect(call.authorization).toBe('Bearer EAAG-test-access-token-0000000000');
    expect(call.body).toMatchObject({ to: waId, type: 'text', text: { body: 'أهلاً بك' } });

    const id = first.json().message.id;
    let row = await messageRow(h, t, id);
    expect(row).toMatchObject({ status: 'accepted', wamid: 'wamid.FAKE1' });

    const at = (s: number) => new Date(h.clock.now().getTime() + s * 1000);
    // Out of order: read arrives before delivered; duplicates are ignored.
    await postWebhook(h, t, statusPayload(t, [{ wamid: 'wamid.FAKE1', status: 'sent', at: at(1) }, { wamid: 'wamid.FAKE1', status: 'read', at: at(3) }]));
    await postWebhook(h, t, statusPayload(t, [{ wamid: 'wamid.FAKE1', status: 'delivered', at: at(2) }]));
    await postWebhook(h, t, statusPayload(t, [{ wamid: 'wamid.FAKE1', status: 'delivered', at: at(2) }]));
    await h.drain();

    row = await messageRow(h, t, id);
    expect(row.status).toBe('read');
    const history = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('message_status_events').select('status').where('message_id', '=', id).orderBy('occurred_at').execute());
    expect(history.map((e) => e.status)).toEqual(['sent', 'delivered', 'read']);
  });

  it('retries transient Meta errors with backoff, then succeeds', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    h.graph.nextOnce('POST /', () => json(503, { error: { message: 'Service unavailable', code: 131016 } }));
    const res = await sendText(h, t, conversationId, 'retry me');
    const id = res.json().message.id;

    const first = await h.drain();
    expect(first.retried).toBe(1);
    let row = await messageRow(h, t, id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });

    h.clock.advance(15 * 60_000);
    await h.drain();
    row = await messageRow(h, t, id);
    expect(row).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(h.graph.messageCalls()).toHaveLength(2);
  });

  it('does not resend after an ambiguous timeout', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    h.graph.nextOnce('POST /', () => new DOMException('The operation was aborted', 'AbortError'));
    const id = (await sendText(h, t, conversationId, 'maybe sent')).json().message.id;
    await h.drain();
    h.clock.advance(3600_000);
    await h.drain();
    expect(await messageRow(h, t, id)).toMatchObject({ status: 'failed', status_reason: 'ambiguous_delivery' });
    expect(h.graph.messageCalls()).toHaveLength(1);
    const events = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('outbox_events').select('topic').where('topic', '=', 'whatsapp.message.needs_review').execute());
    expect(events).toHaveLength(1);
  });

  it('records an opt-out when Meta reports the user stopped marketing', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const { conversationId, customerId } = await receiveText(h, t, randomWaId(), 'hi');
    h.graph.nextOnce('POST /', () => json(400, { error: { message: 'User opted out', code: 131050 } }));
    const id = (await sendText(h, t, conversationId, 'x')).json().message.id;
    await h.drain();
    expect(await messageRow(h, t, id)).toMatchObject({ status: 'failed', status_reason: 'recipient_opted_out' });
    const customer = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('customers').select('opted_out_at').where('id', '=', customerId).executeTakeFirstOrThrow());
    expect(customer.opted_out_at).not.toBeNull();
  });

  it('disables sending for the account when Meta rejects the token', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    h.graph.nextOnce('POST /', () => json(401, { error: { message: 'Invalid OAuth access token', code: 190 } }));
    await sendText(h, t, conversationId, 'x');
    await h.drain();
    const acct = await ownerQuery<{ status: string; sending_enabled: boolean }>('SELECT status, sending_enabled FROM whatsapp_accounts WHERE id = $1', [t.accountId]);
    expect(acct.rows[0]).toEqual({ status: 'verification_failed', sending_enabled: false });
    // Subsequent messages are blocked before reaching Meta.
    const next = await sendText(h, t, conversationId, 'y');
    expect(next.json().message.statusReason).toBe('account_not_enabled');
  });

  it('re-checks policy at send time (consent/window changes after queueing)', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hi');
    h.clock.advance(23.99 * 3600_000);
    const id = (await sendText(h, t, conversationId, 'just in time?')).json().message.id;
    h.clock.advance(60_000); // window closes before the worker runs
    await h.drain();
    expect(await messageRow(h, t, id)).toMatchObject({ status: 'blocked', status_reason: 'outside_service_window' });
    expect(h.graph.messageCalls()).toHaveLength(0);
  });
});

describe('opt-out keywords', () => {
  it('handles an Arabic opt-out: records it, confirms, and blocks later templates', async () => {
    const h = await makeHarness({ outboundMode: 'live' });
    const t = await seedTenant(h.deps, { accountState: 'verified_enabled' });
    await seedTemplate(h.deps, t, { name: 'utility', bodyText: 'Order ready' });
    const { conversationId, customerId } = await receiveText(h, t, randomWaId(), 'إيقاف');

    await withTenant(h.deps.db, t.legalEntityId, async (trx) => {
      const c = await trx.selectFrom('customers').selectAll().where('id', '=', customerId).executeTakeFirstOrThrow();
      expect(c.opted_out_at).not.toBeNull();
      const consent = await trx.selectFrom('consent_records').selectAll().where('customer_id', '=', customerId).execute();
      expect(consent).toHaveLength(1);
      expect(consent[0]).toMatchObject({ status: 'revoked', source: 'whatsapp_keyword', recorded_by_type: 'customer' });
    });
    // Confirmation goes out in Arabic.
    expect(h.graph.messageCalls()).toHaveLength(1);
    expect((h.graph.messageCalls()[0]!.body as { text: { body: string } }).text.body).toMatch(/تم إيقاف/);

    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/inbox/conversations/${conversationId}/messages`,
      headers: await authHeaders(t, 'agent-1', ['agent']),
      payload: { idempotencyKey: crypto.randomUUID(), template: { name: 'utility', language: 'ar', parameters: [] } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.reason).toBe('customer_opted_out');
  });
});
