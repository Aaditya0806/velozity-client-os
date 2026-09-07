import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveHome } from '@/lib/auth/home';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

// Never prerendered. This page reads the session cookie to decide where an
// already-signed-in person belongs, so its output depends on the request. Left
// as a static candidate, the build evaluates it with no environment configured
// and fails there instead of at the request it was written for.
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  // A client and an internal user both arrive here; they do not both belong in
  // the same place afterwards.
  const home = await resolveHome();
  if (home !== '/sign-in') redirect(home);

  const params = await searchParams;
  return <SignInForm nextPath={params.next ?? '/'} reason={params.reason} />;
}
