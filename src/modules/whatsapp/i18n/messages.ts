import type { Locale } from '../../../platform/db/schema.js';

const MESSAGES = {
  opt_out_confirmed: {
    ar: 'تم إيقاف رسائل العروض. يمكنك إرسال "اشتراك" في أي وقت لإعادة تفعيلها.',
    en: 'You have been unsubscribed from promotional messages. Reply START at any time to subscribe again.',
  },
  opt_in_confirmed: {
    ar: 'شكراً لك، تم تسجيل موافقتك على استلام العروض من {brand}.',
    en: 'Thank you, you are now subscribed to offers from {brand}.',
  },
  handoff_ack: {
    ar: 'شكراً لتواصلك. سيقوم أحد ممثلي خدمة العملاء بالرد عليك قريباً.',
    en: 'Thanks for reaching out. A customer service representative will reply shortly.',
  },
} as const satisfies Record<string, Record<Locale, string>>;

export type SystemMessageKey = keyof typeof MESSAGES;

/** System texts are per tenant: {brand} is the legal entity's display name. */
export function systemMessage(key: SystemMessageKey, locale: Locale | null | undefined, vars: { brand: string }): string {
  return MESSAGES[key][locale ?? 'ar'].replaceAll('{brand}', vars.brand);
}
