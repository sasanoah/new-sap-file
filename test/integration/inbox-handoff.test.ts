import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/platform/db/database.js';
import type { AiAssistant, AiDecision, AiDraftInput } from '../../src/modules/whatsapp/ai/assistant.js';
import { authHeaders, closeAll, makeHarness, randomWaId, receiveText, seedTenant, type Harness, type Tenant } from '../helpers/fixtures.js';

afterAll(closeAll);

class ScriptedAi implements AiAssistant {
  readonly inputs: AiDraftInput[] = [];
  constructor(private readonly next: (input: AiDraftInput) => AiDecision) {}
  async draftReply(input: AiDraftInput) {
    this.inputs.push(input);
    return this.next(input);
  }
}

const conversation = (h: Harness, t: Tenant, id: string) =>
  withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('conversations').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
const outbound = (h: Harness, t: Tenant, conversationId: string) =>
  withTenant(h.deps.db, t.legalEntityId, (trx) =>
    trx.selectFrom('messages').select(['text_body', 'sender_type', 'status']).where('conversation_id', '=', conversationId).where('direction', '=', 'outbound').orderBy('created_at').execute(),
  );

describe('AI assistant', () => {
  it('replies through the outbound policy when confident', async () => {
    const ai = new ScriptedAi(() => ({ action: 'reply', text: 'أهلاً! كيف أقدر أساعدك؟', confidence: 0.92, language: 'ar', reason: 'greeting' }));
    const h = await makeHarness({ outboundMode: 'dry_run', ai });
    const t = await seedTenant(h.deps, { aiEnabled: true });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'مرحبا');

    expect(ai.inputs).toHaveLength(1);
    expect(ai.inputs[0]).toMatchObject({ brand: 'Bed Janssen', locale: 'ar', history: [{ from: 'customer', text: 'مرحبا' }] });
    expect((await conversation(h, t, conversationId)).handling_mode).toBe('ai');
    expect(await outbound(h, t, conversationId)).toEqual([{ text_body: 'أهلاً! كيف أقدر أساعدك؟', sender_type: 'ai', status: 'dry_run' }]);
  });

  it('hands off to a human on low confidence and acknowledges the customer', async () => {
    const ai = new ScriptedAi(() => ({ action: 'reply', text: 'Maybe 2 days?', confidence: 0.3, language: 'en', reason: 'unsure about delivery' }));
    const h = await makeHarness({ outboundMode: 'dry_run', ai });
    const t = await seedTenant(h.deps, { aiEnabled: true });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'When will my order arrive?');

    const conv = await conversation(h, t, conversationId);
    expect(conv.handling_mode).toBe('human_queue');
    const msgs = await outbound(h, t, conversationId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ sender_type: 'system' });
    expect(msgs[0]!.text_body).toMatch(/representative/);
    const handoffs = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('handoffs').selectAll().execute());
    expect(handoffs[0]).toMatchObject({ requested_by_type: 'ai', reason: 'low_confidence:0.3' });
  });

  it('routes a customer asking for a person straight to an available agent who speaks their language', async () => {
    const ai = new ScriptedAi(() => {
      throw new Error('AI should not be called for an explicit human request');
    });
    const h = await makeHarness({ outboundMode: 'dry_run', ai });
    const t = await seedTenant(h.deps, { aiEnabled: true });
    const agent = await authHeaders(t, 'agent-ar', ['agent']);
    await h.app.inject({ method: 'PUT', url: '/v1/inbox/agents/me', headers: agent, payload: { status: 'available', languages: ['ar'] } });

    const { conversationId } = await receiveText(h, t, randomWaId(), 'أبي موظف');
    const conv = await conversation(h, t, conversationId);
    expect(conv.handling_mode).toBe('human');
    expect(conv.assigned_agent_id).not.toBeNull();
    expect(ai.inputs).toHaveLength(0);
  });

  it('does not reply if a human took over while the model was thinking', async () => {
    let h!: Harness;
    let t!: Tenant;
    const ai = new ScriptedAi(() => ({ action: 'reply', text: 'late reply', confidence: 0.99, language: 'en', reason: '' }));
    const slowAi: AiAssistant = {
      draftReply: async (input) => {
        // Simulate an agent claiming the conversation mid-flight.
        const conv = await withTenant(h.deps.db, t.legalEntityId, (trx) => trx.selectFrom('conversations').select('id').executeTakeFirstOrThrow());
        await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conv.id}/claim`, headers: await authHeaders(t, 'agent-x', ['agent']) });
        return ai.draftReply(input);
      },
    };
    h = await makeHarness({ outboundMode: 'dry_run', ai: slowAi });
    t = await seedTenant(h.deps, { aiEnabled: true });
    const { conversationId } = await receiveText(h, t, randomWaId(), 'hello');
    expect(await outbound(h, t, conversationId)).toHaveLength(0);
    expect((await conversation(h, t, conversationId)).handling_mode).toBe('human');
  });
});

describe('multi-agent inbox', () => {
  it('lets one agent claim a conversation and prevents a second from taking it', async () => {
    const h = await makeHarness({ outboundMode: 'dry_run' });
    const t = await seedTenant(h.deps);
    const { conversationId } = await receiveText(h, t, randomWaId(), 'Hello');
    const a1 = await authHeaders(t, 'agent-1', ['agent']);
    const a2 = await authHeaders(t, 'agent-2', ['agent']);

    const queue = await h.app.inject({ method: 'GET', url: '/v1/inbox/conversations?mode=human_queue', headers: a1 });
    expect(queue.json().data.map((c: { id: string }) => c.id)).toContain(conversationId);
    expect(queue.json().data[0].serviceWindowOpen).toBe(true);

    expect((await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/claim`, headers: a1 })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/claim`, headers: a2 })).statusCode).toBe(409);

    // Agent 2 cannot reply in agent 1's conversation; a supervisor can.
    const reply = (headers: Record<string, string>) =>
      h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/messages`, headers, payload: { idempotencyKey: crypto.randomUUID(), text: 'hi' } });
    expect((await reply(a2)).statusCode).toBe(403);
    expect((await reply(a1)).statusCode).toBe(202);
    expect((await reply(await authHeaders(t, 'sup-1', ['supervisor']))).statusCode).toBe(202);

    const mine = await h.app.inject({ method: 'GET', url: '/v1/inbox/conversations?mine=true', headers: a1 });
    expect(mine.json().data).toHaveLength(1);
  });

  it('supports agent-to-agent handoff, supervisor assignment and closing', async () => {
    const h = await makeHarness({ outboundMode: 'dry_run' });
    const t = await seedTenant(h.deps);
    const { conversationId } = await receiveText(h, t, randomWaId(), 'Need help');
    const a1 = await authHeaders(t, 'agent-1', ['agent']);
    const sup = await authHeaders(t, 'sup', ['supervisor']);
    await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/claim`, headers: a1 });

    const handoff = await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/handoff`, headers: a1, payload: { reason: 'needs Arabic speaker' } });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toMatchObject({ handling_mode: 'human_queue', assigned_agent_id: null });

    const agent2 = (await h.app.inject({ method: 'PUT', url: '/v1/inbox/agents/me', headers: await authHeaders(t, 'agent-2', ['agent']), payload: { status: 'away' } })).json();
    expect((await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/assign`, headers: a1, payload: { agentId: agent2.id } })).statusCode).toBe(403);
    const assigned = await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/assign`, headers: sup, payload: { agentId: agent2.id } });
    expect(assigned.json()).toMatchObject({ handling_mode: 'human', assigned_agent_id: agent2.id });

    expect((await h.app.inject({ method: 'POST', url: `/v1/inbox/conversations/${conversationId}/close`, headers: a1 })).json().status).toBe('closed');
    // The customer writing again opens a fresh conversation.
    const detail = await h.app.inject({ method: 'GET', url: `/v1/inbox/conversations/${conversationId}`, headers: a1 });
    const next = await receiveText(h, t, detail.json().customer.wa_id, 'Me again');
    expect(next.conversationId).not.toBe(conversationId);

    const audit = await h.app.inject({ method: 'GET', url: `/v1/audit?targetType=conversation&targetId=${conversationId}`, headers: sup });
    expect(audit.json().data.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['conversation.claimed', 'conversation.handoff', 'conversation.closed']),
    );
  });
});
