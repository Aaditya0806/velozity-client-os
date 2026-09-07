import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getContext } from '@/lib/auth/session';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const ctx = await getContext();
  if (ctx) redirect('/dashboard');

  const params = await searchParams;
  return <SignInForm nextPath={params.next ?? '/dashboard'} reason={params.reason} />;
}
