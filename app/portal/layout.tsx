import { redirect } from 'next/navigation';
import { requirePortalContext } from '@/lib/auth/portal';
import { PortalShell } from '@/components/portal/portal-shell';
import { isAppError } from '@/lib/http/errors';

/**
 * Everything beneath this layout is a client's own view of their own work.
 *
 * The check here is a convenience: the portal projections and the
 * `app.portal_*` functions each re-derive authority independently, so a page
 * reached some other way still returns nothing.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  let ctx;
  try {
    ctx = await requirePortalContext();
  } catch (error) {
    if (isAppError(error) && error.code === 'FORBIDDEN') {
      // Signed in, but not as a client. Almost always an internal user who
      // followed a portal link, so send them to their own home rather than to
      // a dead end.
      redirect('/dashboard');
    }
    redirect('/sign-in?next=/portal');
  }

  return (
    <PortalShell
      companyName={ctx.company.name}
      companies={ctx.companies}
      userName={ctx.user.fullName}
      capabilities={ctx.company.capabilities}
    >
      {children}
    </PortalShell>
  );
}
