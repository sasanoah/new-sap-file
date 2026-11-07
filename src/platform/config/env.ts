import { z } from 'zod';

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  // Application connection (role wa_app, subject to RLS).
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // disabled: never send. dry_run: run every check, record, never call Meta. live: send.
  WHATSAPP_OUTBOUND_MODE: z.enum(['disabled', 'dry_run', 'live']).default('disabled'),
  GRAPH_API_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  GRAPH_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  CREDENTIALS_MASTER_KEY: base64Key,
  CREDENTIALS_KEY_ID: z.string().min(1).default('k1'),
  // Optional comma-separated "keyId:base64key" pairs for decrypting older ciphertexts.
  CREDENTIALS_PREVIOUS_KEYS: z.string().optional(),

  AUTH_ISSUER: z.string().min(1),
  AUTH_AUDIENCE: z.string().min(1),
  AUTH_JWKS_URL: z.string().url().optional(),
  // Development/test only: HS256 shared secret. Rejected in production.
  AUTH_HS256_SECRET: z.string().min(32).optional(),

  CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().int().positive().default(1000),
  CAMPAIGN_SEND_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1000),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;
  if (!env.AUTH_JWKS_URL && !env.AUTH_HS256_SECRET) {
    throw new Error('Invalid configuration: set AUTH_JWKS_URL (or AUTH_HS256_SECRET outside production)');
  }
  if (env.NODE_ENV === 'production' && env.AUTH_HS256_SECRET) {
    throw new Error('Invalid configuration: AUTH_HS256_SECRET is not allowed in production; use AUTH_JWKS_URL');
  }
  return env;
}
