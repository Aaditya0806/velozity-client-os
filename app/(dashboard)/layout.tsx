import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { requireContext } from '@/lib/auth/session';
import { AppShell } from '@/components/layout/app-shell';
import { SYSTEM_ROLE_LABELS, type SystemRoleKey } from '@/lib/permissions';
import { isAppError } from '@/lib/http/errors';

/**
 * Every page beneath this layout is authenticated.
 *
 * The check happens here rather than in each page, and again inside every API
 * route and every RLS policy. A layout is a convenience for the user, not a
 * security boundary.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let ctx;
  try {
    ctx = await requireContext();
  } catch (error) {
    const reason = isAppError(error)
      ? error.code === 'SESSION_EXPIRED'
        ? 'session_expired'
        : error.code === 'ACCOUNT_DEACTIVATED'
          ? 'deactivated'
          : error.code === 'NOT_A_MEMBER'
            ? 'no_org'
            : undefined
      : undefined;

    redirect(`/sign-in${reason ? `?reason=${reason}` : ''}`);
  }

  // Read on the server so the rail renders at its remembered width in the first
  // paint. Reading it in the client would collapse the sidebar a frame after
  // the page appears, which looks like a glitch every single load.
  const store = await cookies();
  const collapsed = store.get('velozity_nav')?.value === 'mini';

  const primaryRole = ctx.roleKeys[0] as SystemRoleKey | undefined;

  return (
    <AppShell
      user={{
        fullName: ctx.user.fullName || ctx.user.email,
        email: ctx.user.email,
        roleLabel: primaryRole ? (SYSTEM_ROLE_LABELS[primaryRole] ?? primaryRole) : 'No role assigned',
      }}
      orgName={ctx.org.name}
      orgSlug={ctx.org.slug}
      isDemo={ctx.org.isDemo}
      permissions={ctx.permissions.toArray()}
      memberships={ctx.memberships}
      initialCollapsed={collapsed}
      timezone={ctx.org.timezone}
    >
      {children}
    </AppShell>
  );
}
