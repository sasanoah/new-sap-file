/**
 * Classification of WhatsApp Cloud API failures. Codes follow Meta's published
 * error-code reference; anything unrecognised is treated as non-retryable so an
 * unknown failure never turns into a burst of duplicate sends.
 */
export type GraphErrorClass =
  | 'retryable' // throttling or transient Meta-side failure
  | 'auth' // token invalid/expired or permission missing
  | 'window_closed' // 24h customer-service window has closed
  | 'recipient_opted_out' // recipient stopped marketing messages
  | 'ecosystem_limit' // per-user marketing limit; do not retry soon
  | 'template' // template missing, paused, disabled or parameter mismatch
  | 'recipient' // recipient cannot receive the message
  | 'account' // phone number/account blocked, locked or unregistered
  | 'invalid_request'
  | 'unknown';

/** Whether a failed request might nonetheless have been accepted by Meta. */
export type SendState = 'rejected' | 'not_sent' | 'ambiguous';

const RETRYABLE = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
const AUTH = new Set([0, 3, 10, 190, 200, 299]);
const TEMPLATE = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]);
const RECIPIENT = new Set([131026, 131021, 131051, 131052, 131053, 131008, 131009]);
const ACCOUNT = new Set([368, 131031, 131042, 131045, 133010, 133005, 133006]);

export function classifyGraphError(httpStatus: number, code: number | undefined): GraphErrorClass {
  if (code !== undefined) {
    if (code === 131047) return 'window_closed';
    if (code === 131050) return 'recipient_opted_out';
    if (code === 131049) return 'ecosystem_limit';
    if (RETRYABLE.has(code)) return 'retryable';
    if (AUTH.has(code) || (code >= 200 && code <= 299)) return 'auth';
    if (TEMPLATE.has(code)) return 'template';
    if (RECIPIENT.has(code)) return 'recipient';
    if (ACCOUNT.has(code)) return 'account';
    if (code === 100) return 'invalid_request';
  }
  if (httpStatus === 429 || httpStatus >= 500) return 'retryable';
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus >= 400) return 'invalid_request';
  return 'unknown';
}

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly classification: GraphErrorClass,
    readonly sendState: SendState,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }

  get retryable(): boolean {
    return this.classification === 'retryable' && this.sendState !== 'ambiguous';
  }

  toJSON(): Record<string, unknown> {
    return {
      message: this.message,
      httpStatus: this.httpStatus,
      classification: this.classification,
      sendState: this.sendState,
      code: this.code,
      subcode: this.subcode,
      fbtraceId: this.fbtraceId,
    };
  }
}

/**
 * Network-level failure. Failures before a connection was established mean the
 * request was certainly not delivered; anything after (timeouts, resets) may
 * have reached Meta and is ambiguous.
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

export function networkError(err: unknown): GraphApiError {
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  const notSent = code !== undefined && NOT_SENT_CODES.has(code);
  return new GraphApiError(
    `Network error calling Graph API${code ? ` (${code})` : ''}`,
    0,
    'retryable',
    notSent ? 'not_sent' : 'ambiguous',
  );
}
