export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

/** Exponential backoff with full jitter: random(0, min(max, base * 2^attempt)). */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 2_000;
  const max = opts.maxMs ?? 10 * 60_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

/** Error that should be retried later (transient upstream or ordering problem). */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}
