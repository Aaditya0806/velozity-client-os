import { z } from 'zod';
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase';
import { withService } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { checkRateLimit, RATE_LIMITS } from '@/lib/http/rate-limit';
import { newRequestId } from '@/lib/util/ids';
import { errorResponse } from '@/lib/http/response';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const requestId = newRequestId();

  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Email and password are required.');
    }

    const { email, password } = parsed.data;
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null;

    // Rate limited by address AND by IP: neither a targeted attack on one
    // account nor a spray across many should be cheap.
    await checkRateLimit(`signin:${email.toLowerCase()}`, RATE_LIMITS.auth);
    if (ip) await checkRateLimit(`signin-ip:${ip}`, RATE_LIMITS.auth);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      logger.warn('Failed sign-in attempt', { request_id: requestId, email, ip });

      await withService('record failed sign-in', (tx) =>
        writeAudit(tx, {
          orgId: null,
          action: 'auth.login_failed',
          category: 'auth',
          severity: 'warning',
          actorType: 'system',
          actorLabel: email,
          summary: 'A sign-in attempt failed',
          ipAddress: ip,
          userAgent: request.headers.get('user-agent'),
          requestId,
        }),
      ).catch(() => undefined);

      // Identical response for a wrong password and an unknown address.
      throw new AppError('UNAUTHENTICATED', 'The email or password is incorrect.');
    }

    const profile = await withService('load profile after sign-in', async (tx) => {
      const row = await tx.maybeOne<{ id: string; status: string; full_name: string }>(
        `select id, status, full_name from user_profiles where id = $1 and deleted_at is null`,
        [data.user.id],
      );

      if (row && row.status !== 'deactivated') {
        await tx.query(`update user_profiles set last_seen_at = now() where id = $1`, [row.id]);
        await writeAudit(tx, {
          orgId: null,
          action: 'auth.login',
          category: 'auth',
          actorUserId: row.id,
          summary: 'Signed in',
          ipAddress: ip,
          userAgent: request.headers.get('user-agent'),
          requestId,
        });
      }
      return row;
    });

    if (!profile) {
      await supabase.auth.signOut();
      throw new AppError('UNAUTHENTICATED', 'This account has no profile. Contact an administrator.');
    }

    if (profile.status === 'deactivated') {
      await supabase.auth.signOut();
      throw new AppError('ACCOUNT_DEACTIVATED', 'This account has been deactivated.');
    }

    return NextResponse.json(
      { data: { user_id: profile.id }, request_id: requestId },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
