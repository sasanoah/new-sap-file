import { buildApp, REDACT_PATHS } from './app.js';
import { buildDeps } from './bootstrap.js';
import { loadEnv } from './platform/config/env.js';
import { JwtVerifier } from './platform/auth/verifier.js';

const env = loadEnv();
const deps = buildDeps(env);
const verifier = new JwtVerifier({
  issuer: env.AUTH_ISSUER,
  audience: env.AUTH_AUDIENCE,
  jwksUrl: env.AUTH_JWKS_URL,
  hs256Secret: env.AUTH_HS256_SECRET,
});
const app = await buildApp(deps, verifier, { logger: { level: env.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[redacted]' } } });

const shutdown = async () => {
  await app.close();
  await deps.db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
