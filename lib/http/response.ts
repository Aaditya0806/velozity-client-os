/**
 * API response shapes.
 *
 * Every response - success or failure - carries `request_id`, so a user can
 * quote one number and an operator can find the exact transaction in the logs,
 * the audit trail and the event stream.
 */
import { NextResponse } from 'next/server';
import { AppError, isAppError } from './errors';
import { logger } from '@/lib/util/logger';

export interface ApiMeta {
  request_id: string;
  [key: string]: unknown;
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_more: boolean;
}

export function ok<T>(data: T, requestId: string, meta: Record<string, unknown> = {}, status = 200) {
  return NextResponse.json(
    { data, request_id: requestId, ...(Object.keys(meta).length ? { meta } : {}) },
    { status, headers: { 'x-request-id': requestId } },
  );
}

export function created<T>(data: T, requestId: string, location?: string) {
  const headers: Record<string, string> = { 'x-request-id': requestId };
  if (location) headers['location'] = location;
  return NextResponse.json({ data, request_id: requestId }, { status: 201, headers });
}

export function noContent(requestId: string) {
  return new NextResponse(null, { status: 204, headers: { 'x-request-id': requestId } });
}

export function paginated<T>(
  data: T[],
  pagination: PaginationMeta,
  requestId: string,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json(
    { data, request_id: requestId, meta: { pagination, ...extra } },
    { status: 200, headers: { 'x-request-id': requestId } },
  );
}

/**
 * The single error renderer.
 *
 * An AppError is reported faithfully. Anything else is logged in full and
 * reported as INTERNAL_ERROR with no detail - a stack trace, a SQL fragment or a
 * connection string must never reach a client.
 */
export function errorResponse(error: unknown, requestId: string) {
  const appError = isAppError(error)
    ? error
    : new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { cause: error });

  const level = appError.status >= 500 ? 'error' : 'warn';
  logger[level]('API error', {
    request_id: requestId,
    code: appError.code,
    status: appError.status,
    message: appError.message,
    ...(appError.status >= 500 ? { error: appError.cause ?? appError } : {}),
  });

  return NextResponse.json(
    { error: appError.toJSON(), request_id: requestId },
    { status: appError.status, headers: { 'x-request-id': requestId } },
  );
}
