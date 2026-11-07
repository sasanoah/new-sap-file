import { z } from 'zod';

// Lenient schemas: Meta adds fields over time, so unknown keys pass through and
// only the fields this module relies on are validated.

export const InboundMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    button: z.object({ text: z.string().optional(), payload: z.string().optional() }).passthrough().optional(),
    interactive: z.record(z.string(), z.unknown()).optional(),
    context: z.object({ id: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const StatusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    errors: z.array(z.record(z.string(), z.unknown())).optional(),
    pricing: z.record(z.string(), z.unknown()).optional(),
    conversation: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type StatusUpdate = z.infer<typeof StatusSchema>;

export const MessagesValueSchema = z
  .object({
    messaging_product: z.literal('whatsapp').optional(),
    metadata: z.object({ phone_number_id: z.string(), display_phone_number: z.string().optional() }).passthrough(),
    contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
    messages: z.array(InboundMessageSchema).optional(),
    statuses: z.array(StatusSchema).optional(),
    errors: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
export type MessagesValue = z.infer<typeof MessagesValueSchema>;

export const TemplateStatusValueSchema = z
  .object({
    event: z.string(),
    message_template_id: z.union([z.string(), z.number()]).optional(),
    message_template_name: z.string(),
    message_template_language: z.string(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

export const WebhookEnvelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: z.record(z.string(), z.unknown()) })),
    }),
  ),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

/** Deterministic JSON (sorted keys) so identical Meta retries hash identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Text a human would read for an inbound message, for inbox previews and AI input. */
export function extractText(msg: InboundMessage): string | null {
  if (msg.text?.body) return msg.text.body;
  if (msg.button?.text) return msg.button.text;
  const interactive = msg.interactive as
    | { button_reply?: { title?: string }; list_reply?: { title?: string } }
    | undefined;
  return interactive?.button_reply?.title ?? interactive?.list_reply?.title ?? null;
}
