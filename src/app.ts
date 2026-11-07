import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { TokenVerifier } from './platform/auth/verifier.js';
import { AppError } from './platform/http/errors.js';
import type { WhatsAppDeps } from './modules/whatsapp/context.js';
import { webhookRoutes } from './modules/whatsapp/http/webhook-routes.js';
import { apiRoutes } from './modules/whatsapp/http/api-routes.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  '*.accessToken',
  '*.appSecret',
  '*.verifyToken',
  '*.access_token_ciphertext',
  '*.app_secret_ciphertext',
];

export async function buildApp(deps: WhatsAppDeps, verifier: TokenVerifier, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    trustProxy: true,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'bad_request', message: 'Invalid request', details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } },
        requestId: req.id,
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: (err as Error).message }, requestId: req.id });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' }, requestId: req.id });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.db.selectFrom('legal_entities').select('id').limit(1).execute();
      return { status: 'ready', outboundMode: deps.config.outboundMode };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  await app.register(webhookRoutes(deps), { prefix: '/webhooks/whatsapp' });
  await app.register(apiRoutes(deps, verifier), { prefix: '/v1' });
  return app;
}
