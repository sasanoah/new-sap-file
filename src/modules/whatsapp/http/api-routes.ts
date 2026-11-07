import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../../platform/db/database.js';
import type { Actor } from '../../../platform/audit/audit.js';
import { authenticate, principalOf, requirePlatformRole, requireTenant, tenantOf } from '../../../platform/auth/plugin.js';
import type { TokenVerifier } from '../../../platform/auth/verifier.js';
import { AppError, notFound } from '../../../platform/http/errors.js';
import {
  createLegalEntity,
  registerAccount,
  registerMetaApp,
  setAccessToken,
  setAiAssistantEnabled,
  setSendingEnabled,
  verifyAccount,
} from '../accounts/accounts.js';
import { presentAccount } from '../accounts/credentials.js';
import { createCampaign, decideCampaign, launchCampaign, submitCampaign } from '../campaigns/campaigns.js';
import { isServiceWindowOpen } from '../compliance/policy.js';
import type { WhatsAppDeps } from '../context.js';
import { getMarketingConsent, recordMarketingConsent } from '../customers/customers.js';
import {
  claimConversation,
  closeConversation,
  ensureAgent,
  handoffToHuman,
  loadConversation,
  returnToAi,
  updateAgentStatus,
} from '../inbox/conversations.js';
import { submitOutbound } from '../outbound/outbound-service.js';
import { syncTemplates } from '../templates/templates.js';

const uuid = z.string().uuid();
const IdParams = z.object({ id: uuid });

const userActor = (req: FastifyRequest): Actor & { id: string } => ({ type: 'user', id: principalOf(req).subject });

export function apiRoutes(deps: WhatsAppDeps, verifier: TokenVerifier): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', authenticate(verifier));

    // ------------------------------------------------------------ platform
    app.post('/platform/legal-entities', { preHandler: requirePlatformRole('platform_admin') }, async (req, reply) => {
      const body = z
        .object({
          code: z.string().regex(/^[a-z0-9-]{2,64}$/),
          name: z.string().min(1).max(200),
          defaultLocale: z.enum(['ar', 'en']).default('ar'),
          timezone: z.string().min(1).default('Asia/Riyadh'),
        })
        .parse(req.body);
      return reply.status(201).send(await createLegalEntity(deps, body, userActor(req), req.id));
    });

    app.post('/platform/meta-apps', { preHandler: requirePlatformRole('platform_admin') }, async (req, reply) => {
      const body = z
        .object({
          metaAppId: z.string().regex(/^\d{5,20}$/),
          displayName: z.string().min(1).max(200),
          appSecret: z.string().min(16),
          verifyToken: z.string().min(16),
          graphApiVersion: z.string().regex(/^v\d+\.\d+$/),
        })
        .parse(req.body);
      return reply.status(201).send(await registerMetaApp(deps, body, userActor(req), req.id));
    });

    // ------------------------------------------------------------ accounts
    const admin = { preHandler: requireTenant('entity_admin') };

    app.get('/whatsapp/accounts', admin, async (req) => {
      const { legalEntityId } = tenantOf(req);
      const rows = await withTenant(deps.db, legalEntityId, (trx) => trx.selectFrom('whatsapp_accounts').selectAll().orderBy('created_at').execute());
      return { data: rows.map(presentAccount) };
    });

    app.post('/whatsapp/accounts', admin, async (req, reply) => {
      const body = z
        .object({
          metaAppId: z.string().min(1),
          wabaId: z.string().regex(/^\d{5,25}$/),
          phoneNumberId: z.string().regex(/^\d{5,25}$/),
          displayPhoneNumber: z.string().min(5).max(32),
        })
        .parse(req.body);
      return reply.status(201).send(await registerAccount(deps, tenantOf(req).legalEntityId, body, userActor(req), req.id));
    });

    app.put('/whatsapp/accounts/:id/credentials', admin, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { accessToken } = z.object({ accessToken: z.string().min(20) }).parse(req.body);
      return setAccessToken(deps, tenantOf(req).legalEntityId, id, accessToken, userActor(req), req.id);
    });

    app.post('/whatsapp/accounts/:id/verify', admin, async (req) => {
      const { id } = IdParams.parse(req.params);
      return verifyAccount(deps, tenantOf(req).legalEntityId, id, userActor(req), req.id);
    });

    // Enabling production sending is a platform-admin decision on top of entity access.
    app.post('/whatsapp/accounts/:id/sending', admin, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      if (enabled && !principalOf(req).platformRoles.includes('platform_admin')) {
        throw new AppError('forbidden', 'Only a platform admin can enable sending');
      }
      return setSendingEnabled(deps, tenantOf(req).legalEntityId, id, enabled, userActor(req), req.id);
    });

    app.post('/whatsapp/accounts/:id/ai-assistant', admin, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      return setAiAssistantEnabled(deps, tenantOf(req).legalEntityId, id, enabled, userActor(req), req.id);
    });

    app.post('/whatsapp/accounts/:id/templates/sync', admin, async (req) => {
      const { id } = IdParams.parse(req.params);
      return syncTemplates(deps, tenantOf(req).legalEntityId, id, userActor(req), req.id);
    });

    app.get('/whatsapp/templates', { preHandler: requireTenant('agent') }, async (req) => {
      const { legalEntityId } = tenantOf(req);
      const rows = await withTenant(deps.db, legalEntityId, (trx) =>
        trx.selectFrom('message_templates').select(['id', 'whatsapp_account_id', 'name', 'language', 'category', 'status', 'body_parameter_count', 'components', 'synced_at']).orderBy('name').execute(),
      );
      return { data: rows };
    });

    // --------------------------------------------------------------- inbox
    const agent = { preHandler: requireTenant('agent') };

    app.get('/inbox/conversations', agent, async (req) => {
      const q = z
        .object({
          status: z.enum(['open', 'closed']).default('open'),
          mode: z.enum(['ai', 'human_queue', 'human']).optional(),
          mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.string().datetime().optional(),
        })
        .parse(req.query);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, async (trx) => {
        const me = await ensureAgent(trx, legalEntityId, principalOf(req));
        let query = trx
          .selectFrom('conversations as c')
          .innerJoin('customers as cu', 'cu.id', 'c.customer_id')
          .select([
            'c.id', 'c.status', 'c.handling_mode', 'c.assigned_agent_id', 'c.last_inbound_at', 'c.last_outbound_at',
            'c.service_window_expires_at', 'c.updated_at', 'cu.id as customer_id', 'cu.profile_name', 'cu.wa_id', 'cu.preferred_locale',
          ])
          .where('c.status', '=', q.status)
          .orderBy('c.updated_at', 'desc')
          .limit(q.limit);
        if (q.mode) query = query.where('c.handling_mode', '=', q.mode);
        if (q.mine) query = query.where('c.assigned_agent_id', '=', me.id);
        if (q.before) query = query.where('c.updated_at', '<', new Date(q.before));
        const rows = await query.execute();
        const now = deps.clock.now();
        return { data: rows.map((r) => ({ ...r, serviceWindowOpen: isServiceWindowOpen(r.last_inbound_at, now) })) };
      });
    });

    app.get('/inbox/conversations/:id', agent, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, async (trx) => {
        const conv = await loadConversation(trx, id);
        const customer = await trx.selectFrom('customers').selectAll().where('id', '=', conv.customer_id).executeTakeFirstOrThrow();
        const messages = await trx
          .selectFrom('messages')
          .select(['id', 'direction', 'type', 'text_body', 'content', 'status', 'status_reason', 'sender_type', 'sender_id', 'occurred_at', 'status_updated_at'])
          .where('conversation_id', '=', id)
          .orderBy('occurred_at')
          .limit(500)
          .execute();
        return {
          conversation: { ...conv, serviceWindowOpen: isServiceWindowOpen(conv.last_inbound_at, deps.clock.now()) },
          customer: { ...customer, marketingConsent: await getMarketingConsent(trx, customer.id) },
          messages,
        };
      });
    });

    app.post('/inbox/conversations/:id/claim', agent, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, async (trx) => {
        const me = await ensureAgent(trx, legalEntityId, principalOf(req));
        return claimConversation(trx, legalEntityId, id, me.id, userActor(req), req.id);
      });
    });

    app.post('/inbox/conversations/:id/assign', { preHandler: requireTenant('supervisor') }, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { agentId } = z.object({ agentId: uuid }).parse(req.body);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, (trx) =>
        handoffToHuman(trx, {
          legalEntityId,
          conversationId: id,
          requestedBy: { ...userActor(req), kind: 'agent' },
          reason: 'supervisor_assignment',
          toAgentId: agentId,
          requestId: req.id,
        }),
      );
    });

    app.post('/inbox/conversations/:id/handoff', agent, async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = z.object({ reason: z.string().min(1).max(500), toAgentId: uuid.optional() }).parse(req.body);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, (trx) =>
        handoffToHuman(trx, {
          legalEntityId,
          conversationId: id,
          requestedBy: { ...userActor(req), kind: 'agent' },
          reason: body.reason,
          toAgentId: body.toAgentId ?? null,
          requestId: req.id,
        }),
      );
    });

    app.post('/inbox/conversations/:id/return-to-ai', agent, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, (trx) => returnToAi(trx, legalEntityId, id, userActor(req), req.id));
    });

    app.post('/inbox/conversations/:id/close', agent, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, (trx) => closeConversation(trx, legalEntityId, id, userActor(req), req.id));
    });

    app.post('/inbox/conversations/:id/messages', agent, async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const body = z
        .object({
          idempotencyKey: z.string().min(8).max(128),
          text: z.string().min(1).max(4096).optional(),
          template: z
            .object({ name: z.string().min(1), language: z.string().min(2), parameters: z.array(z.string().max(1024)).max(20).default([]) })
            .optional(),
        })
        .refine((b) => Boolean(b.text) !== Boolean(b.template), 'Provide exactly one of text or template')
        .parse(req.body);
      const { legalEntityId } = tenantOf(req);
      const result = await withTenant(deps.db, legalEntityId, async (trx) => {
        const me = await ensureAgent(trx, legalEntityId, principalOf(req));
        const conv = await loadConversation(trx, id);
        if (conv.handling_mode === 'human' && conv.assigned_agent_id !== me.id && !tenantOf(req).roles.some((r) => r === 'supervisor' || r === 'entity_admin')) {
          throw new AppError('forbidden', 'Conversation is assigned to another agent');
        }
        return submitOutbound(trx, deps, {
          legalEntityId,
          conversationId: id,
          content: body.text ? { kind: 'text', text: body.text } : { kind: 'template', ...body.template! },
          idempotencyKey: `agent:${body.idempotencyKey}`,
          initiatedBy: 'agent',
          actor: userActor(req),
          requestId: req.id,
        });
      });
      const m = result.message;
      const payload = { message: { id: m.id, status: m.status, statusReason: m.status_reason }, duplicate: result.duplicate };
      if (m.status === 'blocked') {
        const d = result.decision;
        // A compliance violation is the caller's problem (422); a closed gate is an operational state (202, recorded as blocked).
        if (!d || d.allowed || d.kind === 'compliance') {
          return reply.status(422).send({
            error: { code: 'policy_violation', message: d && !d.allowed ? d.message : 'Message was blocked by policy', details: { reason: m.status_reason } },
            ...payload,
            requestId: req.id,
          });
        }
      }
      return reply.status(202).send(payload);
    });

    app.put('/inbox/agents/me', agent, async (req) => {
      const body = z
        .object({
          status: z.enum(['available', 'away', 'offline']).optional(),
          displayName: z.string().min(1).max(100).optional(),
          languages: z.array(z.enum(['ar', 'en'])).min(1).optional(),
        })
        .parse(req.body);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, async (trx) => {
        const me = await ensureAgent(trx, legalEntityId, principalOf(req));
        return updateAgentStatus(trx, me.id, body);
      });
    });

    // ----------------------------------------------------------- customers
    app.get('/customers/:id', agent, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { legalEntityId } = tenantOf(req);
      return withTenant(deps.db, legalEntityId, async (trx) => {
        const customer = await trx.selectFrom('customers').selectAll().where('id', '=', id).executeTakeFirst();
        if (!customer) throw notFound('Customer');
        const conversations = await trx.selectFrom('conversations').select(['id', 'status', 'handling_mode', 'created_at', 'closed_at']).where('customer_id', '=', id).orderBy('created_at', 'desc').limit(50).execute();
        return { ...customer, marketingConsent: await getMarketingConsent(trx, id), conversations };
      });
    });

    app.get('/customers/:id/consents', agent, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { legalEntityId } = tenantOf(req);
      const rows = await withTenant(deps.db, legalEntityId, (trx) =>
        trx.selectFrom('consent_records').selectAll().where('customer_id', '=', id).orderBy('recorded_at', 'desc').execute(),
      );
      return { data: rows };
    });

    app.post('/customers/:id/consents', agent, async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const body = z
        .object({
          purpose: z.literal('marketing'),
          status: z.enum(['granted', 'revoked']),
          source: z.enum(['agent_recorded', 'web_form', 'store', 'import']),
          evidence: z.string().min(5).max(1000),
        })
        .parse(req.body);
      const { legalEntityId } = tenantOf(req);
      const row = await withTenant(deps.db, legalEntityId, async (trx) => {
        const exists = await trx.selectFrom('customers').select('id').where('id', '=', id).executeTakeFirst();
        if (!exists) throw notFound('Customer');
        return recordMarketingConsent(trx, { legalEntityId, customerId: id, status: body.status, source: body.source, evidence: body.evidence, actor: userActor(req), requestId: req.id });
      });
      return reply.status(201).send(row);
    });

    // ----------------------------------------------------------- campaigns
    app.post('/campaigns', admin, async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(200),
          whatsappAccountId: uuid,
          templateId: uuid,
          customerIds: z.array(uuid).min(1),
          templateParameters: z.array(z.string().max(1024)).max(20).default([]),
        })
        .parse(req.body);
      return reply.status(201).send(await createCampaign(deps, tenantOf(req).legalEntityId, body, userActor(req), req.id));
    });

    app.post('/campaigns/:id/submit', admin, async (req) => {
      const { id } = IdParams.parse(req.params);
      return submitCampaign(deps, tenantOf(req).legalEntityId, id, userActor(req), req.id);
    });

    const approver = { preHandler: requireTenant('campaign_approver') };
    app.post('/campaigns/:id/approve', approver, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { note } = z.object({ note: z.string().max(1000).optional() }).parse(req.body ?? {});
      return decideCampaign(deps, tenantOf(req).legalEntityId, id, 'approved', note ?? null, userActor(req), req.id);
    });
    app.post('/campaigns/:id/reject', approver, async (req) => {
      const { id } = IdParams.parse(req.params);
      const { note } = z.object({ note: z.string().min(1).max(1000) }).parse(req.body);
      return decideCampaign(deps, tenantOf(req).legalEntityId, id, 'rejected', note, userActor(req), req.id);
    });

    app.post('/campaigns/:id/launch', admin, async (req) => {
      const { id } = IdParams.parse(req.params);
      return launchCampaign(deps, tenantOf(req).legalEntityId, id, userActor(req), req.id);
    });

    // --------------------------------------------------------------- audit
    app.get('/audit', { preHandler: requireTenant('supervisor') }, async (req) => {
      const q = z
        .object({ targetType: z.string().optional(), targetId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(req.query);
      const { legalEntityId } = tenantOf(req);
      const rows = await withTenant(deps.db, legalEntityId, (trx) => {
        let query = trx.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(q.limit);
        if (q.targetType) query = query.where('target_type', '=', q.targetType);
        if (q.targetId) query = query.where('target_id', '=', q.targetId);
        return query.execute();
      });
      return { data: rows };
    });
  };
}
