/**
 * Where a signed-in identity belongs.
 *
 * There are two doors into this product and they lead to different places. An
 * internal member goes to the dashboard; a client goes to the portal. Deciding
 * that in one place matters because getting it wrong is not a cosmetic bug: a
 * portal user sent to `/dashboard` is refused by `requireContext()` and bounced
 * back to sign-in, which looks exactly like a rejected password.
 */
import 'server-only';
import { getContext } from './session';
import { isPortalUser } from './portal';

export type Home = '/dashboard' | '/portal' | '/sign-in';

export async function resolveHome(): Promise<Home> {
  // Internal membership wins when someone somehow has both: the internal
  // application is the larger surface, and the portal is one click away.
  const ctx = await getContext();
  if (ctx) return '/dashboard';

  if (await isPortalUser()) return '/portal';

  return '/sign-in';
}
