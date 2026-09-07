/**
 * The API boundary.
 *
 * `route()` wraps every handler under /api/v1 and is responsible for the things
 * that must never be forgotten:
 *
 *   - assigning a request id and echoing it on every response;
 *   - resolving the session and the tenant context;
 *   - enforcing the declared permission before the handler body runs;
 *   - rate limiting;
 *   - validating params, query and body with Zod;
 *   - honouring idempotency keys on external-effect endpoints;
 *   - catching everything, so no stack trace escapes.
 *
 * A handler therefore starts from a state where the caller is known, allowed and
 * validated, and can concentrate on the business rule.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from './errors';
import { errorResponse, ok } from './response';
import { newRequestId, sha256Hex } from '@/lib/util/ids';
import { requireContext, type RequestContext } from '@/lib/auth/session';
import { withTenant, type Tx } from '@/lib/db';
import { checkRateLimit, RATE_LIMITS, type RateLimitRule } from './rate-limit';
import { logger } from '@/lib/util/logger';

export interface RouteHandlerArgs<
  TBody = unknown,
  TQuery = unknown,
  TParams = Record<string, string>,
> {
  req: NextRequest;
  ctx: RequestContext;
  body: TBody;
  query: TQuery;
  params: TParams;
  requestId: string;
  /** Runs a callback in the caller's tenant transaction. */
  db<T>(fn: (tx: Tx) => Promise<T>, options?: { readOnly?: boolean; retryOnConflict?: boolean }): Promise<T>;
}

export interface RouteOptions<
  TBodySchema extends ZodTypeAny | undefined = undefined,
  TQuerySchema extends ZodTypeAny | undefined = undefined,
  TParamsSchema extends ZodTypeAny | undefined = undefined,
> {
  /** Permission required before the handler runs. */
  permission?: string;
  /** At least one of these permissions is required. */
  anyPermission?: readonly string[];
  /** Skip authentication. Only for webhooks and health checks. */
  public?: boolean;
  body?: TBodySchema;
  query?: TQuerySchema;
  params?: TParamsSchema;
  rateLimit?: RateLimitRule | false;
  /**
   * Marks the endpoint as having an external side effect. An Idempotency-Key
   * header is then required and replays return the original response.
   */
  idempotent?: boolean;
}

type Infer<T> = T extends ZodTypeAny ? z.infer<T> : undefined;

export function route<
  TBodySchema extends ZodTypeAny | undefined = undefined,
  TQuerySchema extends ZodTypeAny | undefined = undefined,
  TParamsSchema extends ZodTypeAny | undefined = undefined,
>(
  options: RouteOptions<TBodySchema, TQuerySchema, TParamsSchema>,
  handler: (
    args: RouteHandlerArgs<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>>,
  ) => Promise<NextResponse | Response>,
) {
  // Next 15 types the second argument as required, and passes an object with a
  // params promise even for a route with no dynamic segments.
  return async (
    req: NextRequest,
    routeContext: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse | Response> => {
    const requestId = req.headers.get('x-request-id') ?? newRequestId();
    const started = Date.now();
    const log = logger.child({ request_id: requestId, method: req.method, path: new URL(req.url).pathname });

    try {
      const rawParams = routeContext?.params ? await routeContext.params : {};

      const params = options.params
        ? parseOrThrow(options.params, rawParams, 'path parameters')
        : (rawParams as Infer<TParamsSchema>);

      const url = new URL(req.url);
      const rawQuery = Object.fromEntries(url.searchParams.entries());
      const query = options.query
        ? parseOrThrow(options.query, rawQuery, 'query parameters')
        : (rawQuery as Infer<TQuerySchema>);

      let rawBody: unknown = undefined;
      let bodyText = '';
      if (options.body) {
        bodyText = await req.text();
        if (bodyText.length > 0) {
          try {
            rawBody = JSON.parse(bodyText);
          } catch {
            throw new AppError('VALIDATION_ERROR', 'The request body is not valid JSON.');
          }
        }
      }
      const body = options.body
        ? parseOrThrow(options.body, rawBody ?? {}, 'request body')
        : (undefined as Infer<TBodySchema>);

      if (options.public) {
        const publicArgs = {
          req,
          ctx: null as unknown as RequestContext,
          body,
          query,
          params,
          requestId,
          db: () => {
            throw new AppError('INTERNAL_ERROR', 'Public routes have no tenant context.');
          },
        } as RouteHandlerArgs<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>>;
        return await handler(publicArgs);
      }

      const ctx = await requireContext();
      ctx.requestId = requestId;

      // Rate limit before doing any real work, keyed per user so one noisy
      // client cannot starve the tenant.
      const rule =
        options.rateLimit === false
          ? null
          : (options.rateLimit ??
            (options.idempotent
              ? RATE_LIMITS.externalEffect
              : req.method === 'GET'
                ? RATE_LIMITS.read
                : RATE_LIMITS.write));
      if (rule) {
        await checkRateLimit(`${ctx.user.id}`, rule);
      }

      // Authorization. Explicitly separate from authentication above.
      if (options.permission) {
        ctx.permissions.require(options.permission);
      }
      if (options.anyPermission && options.anyPermission.length > 0) {
        const held = options.anyPermission.some((p) => ctx.permissions.has(p));
        if (!held) {
          throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.', {
            details: { requiredAnyOf: options.anyPermission },
          });
        }
      }

      const args: RouteHandlerArgs<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>> = {
        req,
        ctx,
        body,
        query,
        params,
        requestId,
        db: (fn, dbOptions) =>
          withTenant({ userId: ctx.user.id, orgId: ctx.org.id, requestId }, fn, dbOptions),
      };

      if (options.idempotent) {
        const key = req.headers.get('idempotency-key');
        if (!key) {
          throw new AppError(
            'VALIDATION_ERROR',
            'This endpoint has an external effect and requires an Idempotency-Key header.',
            { details: { header: 'Idempotency-Key' } },
          );
        }
        return await withIdempotency(
          ctx,
          key,
          `${req.method} ${url.pathname}`,
          bodyText,
          requestId,
          () => handler(args),
        );
      }

      const response = await handler(args);
      log.info('Request completed', {
        org_id: ctx.org.id,
        user_id: ctx.user.id,
        status: response.status,
        duration_ms: Date.now() - started,
      });
      return response;
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', `Invalid ${what}.`, {
      details: {
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      },
    });
  }
  return result.data;
}

/**
 * Idempotency.
 *
 * The first request with a given key records its response. A replay with the
 * same body returns that stored response without re-running the handler; a
 * replay with a *different* body is a client bug and is rejected rather than
 * silently served the old result.
 */
async function withIdempotency(
  ctx: RequestContext,
  key: string,
  endpoint: string,
  bodyText: string,
  requestId: string,
  run: () => Promise<NextResponse | Response>,
): Promise<NextResponse | Response> {
  const requestHash = sha256Hex(bodyText);

  const existing = await withTenant<{
    status: string;
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  } | null>({ userId: ctx.user.id, orgId: ctx.org.id, requestId }, (tx) =>
    tx.maybeOne(
      `select status, request_hash, response_status, response_body
       from idempotency_keys
       where org_id = $1 and endpoint = $2 and key = $3 and expires_at > now()`,
      [ctx.org.id, endpoint, key],
    ),
  );

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body.',
      );
    }
    if (existing.status === 'completed' && existing.response_status) {
      return NextResponse.json(existing.response_body, {
        status: existing.response_status,
        headers: { 'x-request-id': requestId, 'idempotent-replay': 'true' },
      });
    }
    if (existing.status === 'in_progress') {
      throw new AppError(
        'CONFLICT',
        'A request with this Idempotency-Key is still in progress.',
      );
    }
  }

  await withTenant({ userId: ctx.user.id, orgId: ctx.org.id, requestId }, (tx) =>
    tx.query(
      `insert into idempotency_keys (org_id, user_id, key, endpoint, request_hash, status)
       values ($1,$2,$3,$4,$5,'in_progress')
       on conflict (org_id, endpoint, key) do update set status = 'in_progress'`,
      [ctx.org.id, ctx.user.id, key, endpoint, requestHash],
    ),
  );

  try {
    const response = await run();
    const clone = response.clone();
    let payload: unknown = null;
    try {
      payload = await clone.json();
    } catch {
      payload = null;
    }

    await withTenant({ userId: ctx.user.id, orgId: ctx.org.id, requestId }, (tx) =>
      tx.query(
        `update idempotency_keys
         set status = 'completed', response_status = $4, response_body = $5, completed_at = now()
         where org_id = $1 and endpoint = $2 and key = $3`,
        [ctx.org.id, endpoint, key, response.status, JSON.stringify(payload)],
      ),
    );

    return response;
  } catch (error) {
    await withTenant({ userId: ctx.user.id, orgId: ctx.org.id, requestId }, (tx) =>
      tx.query(
        `update idempotency_keys set status = 'failed', completed_at = now()
         where org_id = $1 and endpoint = $2 and key = $3`,
        [ctx.org.id, endpoint, key],
      ),
    ).catch(() => undefined);
    throw error;
  }
}

export { ok };
