import pino from 'pino';
import { REDACT_PATHS } from './app.js';
import { systemClock } from './platform/clock.js';
import { loadEnv, type Env } from './platform/config/env.js';
import { StaticKeyProvider } from './platform/crypto/key-provider.js';
import { SecretBox } from './platform/crypto/secrets.js';
import { createDb } from './platform/db/database.js';
import { ClaudeAssistant } from './modules/whatsapp/ai/claude-assistant.js';
import type { WhatsAppDeps } from './modules/whatsapp/context.js';

export function buildDeps(env: Env = loadEnv()): WhatsAppDeps {
  const log = pino({ level: env.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
  const secrets = new SecretBox(new StaticKeyProvider(env.CREDENTIALS_KEY_ID, env.CREDENTIALS_MASTER_KEY, env.CREDENTIALS_PREVIOUS_KEYS));
  const ai = env.ANTHROPIC_API_KEY ? new ClaudeAssistant({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL }) : null;
  if (env.WHATSAPP_OUTBOUND_MODE === 'live') {
    log.warn('WHATSAPP_OUTBOUND_MODE=live: messages will be sent to Meta for verified, sending-enabled accounts');
  }
  return {
    db: createDb(env.DATABASE_URL, env.DATABASE_POOL_MAX),
    config: {
      outboundMode: env.WHATSAPP_OUTBOUND_MODE,
      graphBaseUrl: env.GRAPH_API_BASE_URL,
      graphTimeoutMs: env.GRAPH_API_TIMEOUT_MS,
      campaignMaxRecipients: env.CAMPAIGN_MAX_RECIPIENTS,
      campaignSendIntervalMs: env.CAMPAIGN_SEND_INTERVAL_MS,
      aiMinConfidence: env.AI_MIN_CONFIDENCE,
    },
    clock: systemClock,
    secrets,
    log,
    ai,
  };
}
