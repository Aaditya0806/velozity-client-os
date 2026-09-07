import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * Session refresh and route protection.
 *
 * Two jobs, in order of importance:
 *
 *   1. Refresh the Supabase session cookie, so a user working for an hour is not
 *      signed out mid-form.
 *   2. Send an unauthenticated request to the sign-in page instead of rendering
 *      a shell that will immediately fail.
 *
 * This is *not* the authorization boundary. It knows only whether a session
 * cookie exists; it does not know the user's permissions and does not try to.
 * Every route handler resolves the real context, and RLS decides what rows
 * exist. Middleware that pretends to be a security control is a common way to
 * end up with none.
 */
const PUBLIC_PATHS = [
  '/sign-in',
  '/reset-password',
  '/api/v1/auth',
  '/api/v1/webhooks',
  '/api/v1/health',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // A deployment missing this configuration cannot authenticate anyone. Say so
  // once, clearly, rather than letting the SDK throw an opaque error on every
  // request - a misconfigured deployment should be diagnosable from its logs.
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. ' +
        'Authentication is unavailable until they are.',
    );
    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'This deployment is not configured. Contact an administrator.',
        },
      },
      { status: 503 },
    );
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Refreshes the token as a side effect. Must run before the redirect decision.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!user && !isPublic) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } },
        { status: 401 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and the favicon.
    '/((?!_next/static|_next/image|favicon.ico|.*\\\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
};
