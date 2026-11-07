export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'policy_violation'
  | 'precondition_failed'
  | 'upstream_error'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  policy_violation: 422,
  upstream_error: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
export const forbidden = (message = 'Forbidden') => new AppError('forbidden', message);
export const conflict = (message: string, details?: Record<string, unknown>) => new AppError('conflict', message, details);
export const badRequest = (message: string, details?: Record<string, unknown>) => new AppError('bad_request', message, details);
