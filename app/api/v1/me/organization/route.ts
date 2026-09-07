import { z } from 'zod';
import { cookies } from 'next/headers';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { ORG_COOKIE } from '@/lib/auth/session';
import { AppError } from '@/lib/http/errors';

/**
 * Switches the active organisation.
 *
 * The cookie only expresses a preference: RLS re-verifies membership on every
 * query, so setting it to an organisation you do not belong to yields an empty
 * workspace rather than someone else's data. It is still validated here so the
 * user gets a clear error instead of a blank screen.
 */
export const POST = route(
  { rateLimit: false, body: z.object({ slug: z.string().max(64) }) },
  async ({ ctx, body, requestId }) => {
    const target = ctx.memberships.find((m) => m.slug === body.slug);
    if (!target) {
      throw new AppError('NOT_A_MEMBER', 'You are not a member of that organisation.');
    }

    const store = await cookies();
    store.set(ORG_COOKIE, body.slug, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });

    return ok({ organization: target }, requestId);
  },
);

