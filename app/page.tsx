import { redirect } from 'next/navigation';
import { getContext } from '@/lib/auth/session';

export default async function RootPage() {
  const ctx = await getContext();
  redirect(ctx ? '/dashboard' : '/sign-in');
}
