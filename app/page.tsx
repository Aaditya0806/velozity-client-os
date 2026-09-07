import { redirect } from 'next/navigation';
import { resolveHome } from '@/lib/auth/home';

// Never cached. This route's whole answer depends on who is asking, and a copy
// of it produced while signed out sends the person who just signed in straight
// back to the form.
export const dynamic = 'force-dynamic';

export default async function RootPage() {
  redirect(await resolveHome());
}
