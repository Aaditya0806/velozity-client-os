import { z } from 'zod';
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase';
import { checkRateLimit, RATE_LIMITS } from '@/lib/http/rate-limit';
import { newRequestId } from '@/lib/util/ids';
import { serverEnv } from '@/lib/config/env';
import { logger } from '@/lib/util/logger';

const bodySchema = z.object({ email: z.string().email() });

/**
 * Always responds success.
 *
 * Whether an address has an account is not something an unauthenticated caller
 * gets to discover, so the response and its timing do not vary.
 */
export async function POST(request: Request) {
  const requestId = newRequestId();
  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);

  if (parsed.success) {
    try {
      await checkRateLimit(`reset:${parsed.data.email.toLowerCase()}`, RATE_LIMITS.auth);
      const supabase = await createSupabaseServerClient();
      await supabase.auth.resetPasswordForEmail(parsed.data.email, {
        redirectTo: `${serverEnv().APP_URL}/reset-password/confirm`,
      });
    } catch (error) {
      logger.warn('Password reset request failed', { request_id: requestId, error });
    }
  }

  return NextResponse.json({ data: { sent: true }, request_id: requestId });
}
