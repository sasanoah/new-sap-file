import type { Locale } from '../../../platform/db/schema.js';

export interface AiTurn {
  from: 'customer' | 'business';
  text: string;
}

export interface AiDraftInput {
  brand: string;
  locale: Locale | null;
  customerName: string | null;
  history: AiTurn[];
}

export interface AiDecision {
  action: 'reply' | 'handoff';
  text: string;
  confidence: number;
  language: Locale;
  reason: string;
}

/**
 * Port for the customer-service AI. Implementations must never throw for
 * model-side refusals or malformed output: they return a handoff instead, so
 * the customer always ends up with a human rather than a guessed answer.
 */
export interface AiAssistant {
  draftReply(input: AiDraftInput): Promise<AiDecision>;
}

export const handoffDecision = (reason: string, language: Locale = 'ar'): AiDecision => ({
  action: 'handoff',
  text: '',
  confidence: 0,
  language,
  reason,
});
