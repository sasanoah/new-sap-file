import type { FastifyPluginAsync } from 'fastify';
import type { WhatsAppDeps } from '../context.js';
import { ingestWebhook, verifySubscription } from '../webhook/ingest.js';

export function webhookRoutes(deps: WhatsAppDeps): FastifyPluginAsync {
  return async (app) => {
    // Signature validation needs the exact bytes Meta signed.
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    app.get<{ Params: { metaAppId: string }; Querystring: Record<string, unknown> }>('/:metaAppId', async (req, reply) => {
      const result = await verifySubscription(deps.db, req.params.metaAppId, req.query);
      if (!result.ok) return reply.status(403).send('Forbidden');
      return reply.type('text/plain').send(result.challenge);
    });

    app.post<{ Params: { metaAppId: string } }>('/:metaAppId', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.headers['x-hub-signature-256'];
      const result = await ingestWebhook(deps, req.params.metaAppId, raw, typeof sig === 'string' ? sig : undefined);
      if (!result.ok) {
        req.log.warn({ reason: result.reason, metaAppId: req.params.metaAppId }, 'webhook rejected');
        return reply.status(result.status).send({ error: result.reason });
      }
      return reply.status(200).send({ received: true });
    });
  };
}
