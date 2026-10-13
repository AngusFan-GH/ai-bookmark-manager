// src/shared/errors.ts
//
// Error codes used by background router. Match dev guide § 9.2.
// Each error has: code, message, retryable.

export type ErrorCode =
  | 'PERMISSION_REQUIRED'
  | 'BOOKMARK_NOT_FOUND'
  | 'PLAN_STALE'
  | 'NETWORK_TIMEOUT'
  | 'RATE_LIMITED'
  | 'AI_SCHEMA_INVALID'
  | 'STORAGE_MIGRATION_FAILED'
  | 'TASK_CANCELLED'
  | 'INVALID_REQUEST'
  | 'BACKGROUND_UNAVAILABLE'
  | 'UNKNOWN';

export interface AppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export function makeError(code: ErrorCode, message: string, retryable = false): AppError {
  return { code, message, retryable };
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppErrorImpl) return err.toJSON();
  if (err instanceof Error) {
    // Best-effort mapping for known messages thrown by code that has not
    // been migrated to AppErrorImpl yet.
    if (/permission/i.test(err.message)) return makeError('PERMISSION_REQUIRED', err.message, false);
    if (/not found/i.test(err.message)) return makeError('BOOKMARK_NOT_FOUND', err.message, false);
    return makeError('UNKNOWN', err.message, false);
  }
  return makeError('UNKNOWN', String(err), false);
}

export class AppErrorImpl extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = retryable;
  }
  toJSON(): AppError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
