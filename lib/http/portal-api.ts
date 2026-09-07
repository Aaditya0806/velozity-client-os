/**
 * The portal's API boundary.
 *
 * A deliberate sibling of `route()` rather than a flag on it. The two boundaries
 * differ in what they trust and what they can reach, and expressing that as an
 * `if` inside one function is how a portal request eventually acquires an
 * internal permission set by accident.
 *
 * What is the same: request ids, Zod validation, rate limiting, and a catch that
 * lets no stack trace escape.
 *
 * What is different, and is the point:
 *   - the session resolves through `portal_users`, never through membership;
 *   - authority is a capability the client holds, not a `resource:action:scope`
 *     permission;
 *   - the transaction is read-only, so every write must go through an
 *     `app.portal_*` function that re-checks authority in SQL.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from './errors';
import { errorResponse } from './response';
import { newRequestId } from '@/lib/util/ids';
import { requirePortalContext, type PortalContext, type PortalCapabilities } from '@/lib/auth/portal';
import { withTenant, type Tx } from '@/lib/db';
import { checkRateLimit, RATE_LIMITS, type RateLimitRule } from './rate-limit';
import { logger } from '@/lib/util/logger';

export interface PortalHandlerArgs<
  TBody = unknown,
  TQuery = unknown,
  TParams = Record<string, string>,
> {
  req: NextRequest;
  ctx: PortalContext;
  body: TBody;
  query: TQuery;
  params: TParams;
  requestId: string;
  /**
   * Runs a callback in the client's transaction. Read-only unless
   * `writable: true`, which exists only so a handler can call an
   * `app.portal_*` function — never to update a table directly.
   */
  db<T>(fn: (tx: Tx) => Promise<T>, options?: { writable?: boolean }): Promise<T>;
}

export interface PortalRouteOptions<
  TBodySchema extends ZodTypeAny | undefined = undefined,
  TQuerySchema extends ZodTypeAny | undefined = undefined,
  TParamsSchema extends ZodTypeAny | undefined = undefined,
> {
  /** Capability the client must hold. Checked again in SQL by every function. */
  capability?: keyof PortalCapabilities;
  body?: TBodySchema;
  query?: TQuerySchema;
  params?: TParamsSchema;
  rateLimit?: RateLimitRule | false;
}

type Infer<T> = T extends ZodTypeAny ? z.infer<T> : undefined;

export function portalRoute<
  TBodySchema extends ZodTypeAny | undefined = undefined,
  TQuerySchema extends ZodTypeAny | undefined = undefined,
  TParamsSchema extends ZodTypeAny | undefined = undefined,
>(
  options: PortalRouteOptions<TBodySchema, TQuerySchema, TParamsSchema>,
  handler: (
    args: PortalHandlerArgs<Infer<TBodySchema>, Infer<TQuerySchema>, Infer<TParamsSchema>>,
  ) => Promise<NextResponse | Response>,
) {
  return async (
    req: NextRequest,
    routeContext: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse | Response> => {
    const requestId = req.headers.get('x-request-id') ?? newRequestId();
    const started = Date.now();
    const log = logger.child({
      request_id: requestId,
      method: req.method,
      path: new URL(req.url).pathname,
      surface: 'portal',
    });

    try {
      const rawParams = routeContext?.params ? await routeContext.params : {};
      const params = options.params
        ? parseOrThrow(options.params, rawParams, 'path parameters')
        : (rawParams as Infer<TParamsSchema>);

      const url = new URL(req.url);
      const query = options.query
        ? parseOrThrow(
            options.query,
            Object.fromEntries(url.searchParams.entries()),
            'query parameters',
          )
        : (Object.fromEntries(url.searchParams.entries()) as Infer<TQuerySchema>);

      let body = undefined as Infer<TBodySchema>;
      if (options.body) {
        const text = await req.text();
        let raw: unknown = {};
        if (text.length > 0) {
          try {
            raw = JSON.parse(text);
          } catch {
            throw new AppError('VALIDATION_ERROR', 'The request body is not valid JSON.');
          }
        }
        body = parseOrThrow(options.body, raw, 'request body');
      }

      const ctx = await requirePortalContext();
      ctx.requestId = requestId;

      const rule =
        options.rateLimit === false
          ? null
          : (options.rateLimit ?? (req.method === 'GET' ? RATE_LIMITS.read : RATE_LIMITS.write));
      if (rule) await checkRateLimit(ctx.user.id, rule);

      if (options.capability && !ctx.company.capabilities[options.capability]) {
        // Says nothing about what exists — only that this client cannot do it.
        throw new AppError('FORBIDDEN', 'Your access does not include this.');
      }

      const response = await handler({
        req,
        ctx,
        body,
        query,
        params,
        requestId,
        db: (fn, dbOptions) =>
          withTenant(
            { userId: ctx.user.id, orgId: ctx.company.orgId, requestId },
            fn,
            { readOnly: !dbOptions?.writable },
          ),
      });

      log.info('Portal request completed', {
        company_id: ctx.company.id,
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
