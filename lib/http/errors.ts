/**
 * The application's error vocabulary.
 *
 * Every failure surfaced to a client is an AppError with a stable machine code,
 * an HTTP status and a message written for a human operator. Anything else that
 * escapes is caught at the API boundary and reported as INTERNAL_ERROR with no
 * detail, so a stack trace or a connection string can never reach a response.
 */

export type ErrorCode =
  // 400
  | 'VALIDATION_ERROR'
  | 'INVALID_TRANSITION'
  | 'INVALID_STATE'
  | 'MISSING_TEMPLATE_VARIABLE'
  | 'CURRENCY_MISMATCH'
  | 'OVER_ALLOCATED'
  | 'DEPENDENCY_CYCLE'
  // 401 / 403
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'FORBIDDEN'
  | 'ORG_CONTEXT_REQUIRED'
  | 'NOT_A_MEMBER'
  | 'ACCOUNT_DEACTIVATED'
  // 404
  | 'NOT_FOUND'
  // 409
  | 'CONFLICT'
  | 'PROPOSAL_VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ALREADY_EXISTS'
  // 422 — business rules
  | 'OPPORTUNITY_QUALIFICATION_INCOMPLETE'
  | 'PROPOSAL_NOT_APPROVED'
  | 'PROPOSAL_NOT_ACCEPTED'
  | 'PROPOSAL_VERSION_IMMUTABLE'
  | 'ACCEPTED_VERSION_FROZEN'
  | 'CONTRACT_NOT_APPROVED'
  | 'CONTRACT_TERMINAL'
  | 'CONTRACT_IMMUTABLE'
  | 'EXECUTED_DOCUMENT_REQUIRED'
  | 'LEGAL_GATE_BLOCKED'
  | 'OVERRIDE_PERMANENT'
  | 'OVERRIDE_INCOMPLETE'
  | 'DOCUMENT_IMMUTABLE'
  | 'DOCUMENT_DELETED'
  | 'TEMPLATE_VERSION_FROZEN'
  | 'AI_ACTION_NOT_PENDING'
  | 'AI_ACTION_NOT_APPROVED'
  | 'AI_DISABLED'
  // 429
  | 'RATE_LIMITED'
  // 5xx
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR'
  // security
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'DOCUMENT_HASH_MISMATCH';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_TRANSITION: 400,
  INVALID_STATE: 400,
  MISSING_TEMPLATE_VARIABLE: 400,
  CURRENCY_MISMATCH: 400,
  OVER_ALLOCATED: 400,
  DEPENDENCY_CYCLE: 400,

  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  ORG_CONTEXT_REQUIRED: 403,
  NOT_A_MEMBER: 403,
  ACCOUNT_DEACTIVATED: 403,

  NOT_FOUND: 404,

  CONFLICT: 409,
  PROPOSAL_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  ALREADY_EXISTS: 409,

  OPPORTUNITY_QUALIFICATION_INCOMPLETE: 422,
  PROPOSAL_NOT_APPROVED: 422,
  PROPOSAL_NOT_ACCEPTED: 422,
  PROPOSAL_VERSION_IMMUTABLE: 422,
  ACCEPTED_VERSION_FROZEN: 422,
  CONTRACT_NOT_APPROVED: 422,
  CONTRACT_TERMINAL: 422,
  CONTRACT_IMMUTABLE: 422,
  EXECUTED_DOCUMENT_REQUIRED: 422,
  LEGAL_GATE_BLOCKED: 422,
  OVERRIDE_PERMANENT: 422,
  OVERRIDE_INCOMPLETE: 422,
  DOCUMENT_IMMUTABLE: 422,
  DOCUMENT_DELETED: 422,
  TEMPLATE_VERSION_FROZEN: 422,
  AI_ACTION_NOT_PENDING: 422,
  AI_ACTION_NOT_APPROVED: 422,
  AI_DISABLED: 422,

  RATE_LIMITED: 429,

  PROVIDER_ERROR: 502,
  PROVIDER_UNAVAILABLE: 503,
  DATABASE_ERROR: 500,
  INTERNAL_ERROR: 500,

  WEBHOOK_SIGNATURE_INVALID: 401,
  DOCUMENT_HASH_MISMATCH: 500,
};

export interface AppErrorOptions {
  /** Structured, client-safe detail. Never include secrets or SQL. */
  details?: unknown;
  /** The underlying error, kept for logging only. */
  cause?: unknown;
  /** Overrides the default status for the code. */
  status?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  override readonly cause: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = options.details;
    this.cause = options.cause;
  }

  /** True for failures a caller can reasonably retry. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.code === 'RATE_LIMITED';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

// --- Convenience constructors -----------------------------------------------

export const notFound = (what: string) =>
  new AppError('NOT_FOUND', `${what} was not found.`);

export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError('FORBIDDEN', message);

export const unauthenticated = (message = 'Authentication is required.') =>
  new AppError('UNAUTHENTICATED', message);

export const validationError = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, { details });

export const conflict = (message: string, details?: unknown) =>
  new AppError('CONFLICT', message, { details });

/**
 * Translates a PostgreSQL error into an AppError.
 *
 * Business rules are enforced by triggers that raise with a `hint` carrying the
 * machine code, so a constraint violation surfaces to the client with the same
 * vocabulary as an application-level check.
 */
export function fromDatabaseError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const e = error as {
    code?: string;
    message?: string;
    hint?: string | null;
    detail?: string | null;
    constraint?: string | null;
    table?: string | null;
    severity?: string;
    routine?: string;
  };

  // Not every failure inside a transaction is a database failure. A plain
  // JavaScript error reported as DATABASE_ERROR sends whoever debugs it to the
  // wrong place entirely, so anything without a SQLSTATE is treated as what it
  // is: an unexpected application error, with the real message kept for the log.
  const looksLikePostgres =
    typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && e.severity !== undefined;

  if (!looksLikePostgres && !e.constraint) {
    return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { cause: error });
  }

  const hint = e.hint ?? undefined;
  if (hint && hint in STATUS_BY_CODE) {
    let details: unknown;
    if (e.detail) {
      try {
        details = JSON.parse(e.detail);
      } catch {
        details = e.detail;
      }
    }
    return new AppError(hint as ErrorCode, cleanMessage(e.message), { details, cause: error });
  }

  switch (e.code) {
    case '23505': // unique_violation
      return new AppError('ALREADY_EXISTS', 'A record with these values already exists.', {
        details: e.constraint ? { constraint: e.constraint } : undefined,
        cause: error,
      });
    case '23503': // foreign_key_violation
      return new AppError('VALIDATION_ERROR', 'A referenced record does not exist.', {
        details: e.constraint ? { constraint: e.constraint } : undefined,
        cause: error,
      });
    case '23514': // check_violation
      return new AppError('VALIDATION_ERROR', cleanMessage(e.message), { cause: error });
    case '42501': // insufficient_privilege — an RLS or trigger denial
      return new AppError('FORBIDDEN', cleanMessage(e.message), { cause: error });
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return new AppError('CONFLICT', 'The record was modified concurrently. Please retry.', {
        cause: error,
      });
    case '57014': // query_canceled
      return new AppError('INTERNAL_ERROR', 'The request took too long and was cancelled.', {
        cause: error,
      });
    default:
      return new AppError('DATABASE_ERROR', 'A database error occurred.', { cause: error });
  }
}

/**
 * PostgreSQL messages are safe to relay (they are our own trigger text), but
 * strip anything that looks like a query fragment or a connection detail.
 */
function cleanMessage(message: string | undefined): string {
  if (!message) return 'The operation could not be completed.';
  const firstLine = message.split('\n')[0]?.trim() ?? message;
  if (/postgres(ql)?:\/\/|password=|host=/i.test(firstLine)) {
    return 'The operation could not be completed.';
  }
  return firstLine.length > 400 ? `${firstLine.slice(0, 397)}...` : firstLine;
}
