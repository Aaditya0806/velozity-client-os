/**
 * Supabase clients.
 *
 * Auth is the only thing we use Supabase's own SDK for in a request path. All
 * business data goes through the pg driver so that a multi-step operation is one
 * transaction. Storage uses the SDK too, but always behind a permission check.
 */
import 'server-only';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * We do not generate database types from Supabase: every business query goes
 * through the pg driver with hand-written SQL, so the SDK is only ever used for
 * auth and storage. This alias keeps the two SDK entry points structurally
 * compatible without pulling in a generated schema type.
 */
type AuthStorageClient = ReturnType<typeof createServerClient>;
import { cookies } from 'next/headers';
import { serverEnv } from '@/lib/config/env';

/**
 * Request-scoped client bound to the caller's session cookies. Used to read the
 * authenticated user and to refresh the session.
 */
export async function createSupabaseServerClient(): Promise<AuthStorageClient> {
  const env = serverEnv();
  const cookieStore = await cookies();

  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, {
              ...(options as CookieOptions),
              httpOnly: true,
              sameSite: 'lax',
              secure: process.env.NODE_ENV === 'production',
              path: '/',
            });
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only for trusted background work: issuing signed URLs after the caller's
 * permission has already been verified, storing an executed contract fetched
 * from a signature provider, and similar. Never call this from a route handler
 * on behalf of a user without an explicit permission check first.
 */
let serviceClient: SupabaseClient | null = null;

export function createSupabaseServiceClient(): SupabaseClient {
  const env = serverEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. Storage and background jobs require it.',
    );
  }
  serviceClient ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}
