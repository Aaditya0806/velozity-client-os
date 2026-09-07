/**
 * Creating the Supabase Auth identity behind a portal user.
 *
 * The database function that grants access takes an auth user id and does not
 * create one, because GoTrue is not reachable from SQL. That leaves one step
 * that must happen outside the transaction, and this is it — kept small, and
 * kept away from the authority decision, which stays in
 * `app.grant_portal_access`.
 */
import 'server-only';
import { serverEnv } from '@/lib/config/env';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

interface AdminUser {
  id: string;
  email?: string;
}

/**
 * Returns the auth user id for this email, creating the account if needed.
 *
 * No password is set. The client receives a recovery link and chooses their
 * own, so a password this system generated never exists anywhere to be leaked
 * or reused.
 */
export async function provisionAuthUser(email: string, fullName: string): Promise<string> {
  const env = serverEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'Portal invitations need SUPABASE_SERVICE_ROLE_KEY, which is not configured.',
    );
  }

  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json',
  };
  const normalised = email.trim().toLowerCase();

  const created = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: normalised,
      email_confirm: true,
      user_metadata: { full_name: fullName, portal: true },
    }),
  });

  if (created.ok) {
    const body = (await created.json()) as AdminUser;
    return body.id;
  }

  // Already registered — as another client contact, or as staff. Adopt the
  // existing identity rather than failing: one person, one account.
  const listed = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, {
    headers,
  });

  if (listed.ok) {
    const body = (await listed.json()) as { users?: AdminUser[] };
    const existing = body.users?.find((u) => u.email?.toLowerCase() === normalised);
    if (existing) return existing.id;
  }

  const detail = await created.text();
  logger.error('Could not provision a portal auth user', {
    status: created.status,
    detail: detail.slice(0, 300),
  });
  throw new AppError('PROVIDER_ERROR', 'The client account could not be created.');
}

/**
 * A one-time link the client uses to set a password and sign in.
 *
 * Returned to the caller rather than emailed from here: the product sends
 * client-facing mail through the outbound pipeline, where it is recorded,
 * rate-limited and visible — not by a fetch buried in a service.
 */
export async function createPortalInviteLink(email: string): Promise<string | null> {
  const env = serverEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'recovery',
      email: email.trim().toLowerCase(),
      options: { redirect_to: `${env.APP_URL}/portal` },
    }),
  });

  if (!response.ok) {
    logger.warn('Could not generate a portal invite link', { status: response.status });
    return null;
  }

  const body = (await response.json()) as {
    action_link?: string;
    properties?: { action_link?: string };
  };
  return body.action_link ?? body.properties?.action_link ?? null;
}
