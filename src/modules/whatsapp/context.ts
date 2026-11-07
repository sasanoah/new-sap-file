import type { Logger } from 'pino';
import type { Clock } from '../../platform/clock.js';
import type { SecretBox } from '../../platform/crypto/secrets.js';
import type { Db } from '../../platform/db/database.js';
import type { AiAssistant } from './ai/assistant.js';
import type { OutboundMode } from './compliance/policy.js';
import type { FetchLike } from './connector/graph-client.js';

export interface WhatsAppConfig {
  outboundMode: OutboundMode;
  graphBaseUrl: string;
  graphTimeoutMs: number;
  campaignMaxRecipients: number;
  campaignSendIntervalMs: number;
  aiMinConfidence: number;
}

/** Everything the WhatsApp module needs, injected once at startup (and in tests). */
export interface WhatsAppDeps {
  db: Db;
  config: WhatsAppConfig;
  clock: Clock;
  secrets: SecretBox;
  log: Logger;
  ai: AiAssistant | null;
  /** Override for tests; defaults to global fetch. */
  fetch?: FetchLike;
}
