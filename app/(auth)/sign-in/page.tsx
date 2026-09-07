import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { resolveHome } from '@/lib/auth/home';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

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
