import type { Locale } from '../../../platform/db/schema.js';

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-z]/g;

/** Picks ar/en from the script of a message; null when there is no signal. */
export function detectLocale(text: string | null | undefined): Locale | null {
  if (!text) return null;
  const ar = text.match(ARABIC)?.length ?? 0;
  const en = text.match(LATIN)?.length ?? 0;
  if (ar === 0 && en === 0) return null;
  return ar >= en ? 'ar' : 'en';
}

/** Normalises for keyword matching: case, Arabic diacritics/tatweel and alef/yaa/taa-marbuta variants. */
export function normalizeForKeywords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Exact whole-message matches only, so ordinary sentences containing "stop"
// are not treated as an opt-out.
const OPT_OUT = ['stop', 'unsubscribe', 'stop all', 'opt out', 'optout', 'cancel subscription', 'ايقاف', 'الغاء', 'الغاء الاشتراك', 'توقف', 'وقف', 'لا ارغب'];
const OPT_IN = ['start', 'subscribe', 'opt in', 'unstop', 'اشتراك', 'اشترك', 'ابدا'];
const HUMAN = ['agent', 'human', 'representative', 'talk to agent', 'customer service', 'موظف', 'خدمه العملاء', 'ابي موظف', 'اريد موظف', 'التحدث مع موظف', 'كلم موظف'];

const toSet = (list: string[]) => new Set(list.map(normalizeForKeywords));
const OPT_OUT_SET = toSet(OPT_OUT);
const OPT_IN_SET = toSet(OPT_IN);
const HUMAN_SET = toSet(HUMAN);

export type KeywordIntent = 'opt_out' | 'opt_in' | 'human' | null;

export function detectKeywordIntent(text: string | null | undefined): KeywordIntent {
  if (!text) return null;
  const n = normalizeForKeywords(text);
  if (OPT_OUT_SET.has(n)) return 'opt_out';
  if (OPT_IN_SET.has(n)) return 'opt_in';
  if (HUMAN_SET.has(n)) return 'human';
  return null;
}
