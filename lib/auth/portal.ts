/**
 * Portal session resolution.
 *
 * A portal user is a client contact who has been granted a login. They are not
 * a member of any organisation, so `requireContext()` refuses them by design —
 * this is the separate door, and it opens onto a strictly smaller room.
 *
 * Two rules hold everywhere below:
 *
 *   1. Authority comes from `portal_users`, never from a request. The client
 *      says which page they want; they never say who they are or what they may
 *      see. The `portal.*` views and the `app.portal_*` functions both re-derive
 *      that from the session.
 *
 *   2. Nothing here reads a `public.*` table. The portal projections physically
 *      exclude cost, margin, internal notes and AI analysis, so a bug in this
 *      file cannot leak a column that its queries have no way to name.
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { getAuthUser } from './session';
import { withTenant } from '@/lib/db';
import { AppError } from '@/lib/http/errors';
import { newRequestId } from '@/lib/util/ids';

export const PORTAL_COMPANY_COOKIE = 'velozity_portal_company';

export interface PortalCapabilities {
  viewInvoices: boolean;
  viewDocuments: boolean;
  approveDeliverables: boolean;
}

export interface PortalCompany {
  id: string;
  orgId: string;
  name: string;
  capabilities: PortalCapabilities;
}

export interface PortalUser {
  id: string;
  email: string;
  fullName: string;
  contactId: string;
}

export interface PortalContext {
  requestId: string;
  user: PortalUser;
  company: PortalCompany;
  /** Every company this person has portal access to, for the switcher. */
  companies: Array<{ id: string; name: string }>;
}

interface MembershipRow {
  portal_user_id: string;
  company_id: string;
  org_id: string;
  company_name: string;
  contact_id: string;
  full_name: string;
  email: string;
  can_view_invoices: boolean;
  can_view_documents: boolean;
  can_approve_deliverables: boolean;
}

/**
 * The client's portal memberships.
 *
 * Read with the service connection because a portal user has no organisation
 * context to open a tenant transaction with — the chicken-and-egg that every
 * session resolver has. The query is constrained to this user's own rows, and
 * it is the only place in the portal that runs outside a tenant transaction.
 */
const loadMemberships = cache(async (userId: string): Promise<MembershipRow[]> => {
  const { withService } = await import('@/lib/db');

  return withService(
    'resolve portal memberships',
    async (tx) =>
      tx.many<MembershipRow>(
        `select
           pu.id            as portal_user_id,
           pu.company_id,
           pu.org_id,
           c.name           as company_name,
           pu.contact_id,
           up.full_name,
           up.email,
           pu.can_view_invoices,
           pu.can_view_documents,
           pu.can_approve_deliverables
         from portal_users pu
         join companies c      on c.id = pu.company_id and c.deleted_at is null
         join user_profiles up on up.id = pu.user_id
         where pu.user_id = $1
           and pu.status = 'active'
           and up.status <> 'deactivated'
         order by c.name`,
        [userId],
      ),
    { routine: true },
  );
});

/**
 * True when this signed-in user has portal access, whatever else they may be.
 * Used to route someone to the right home after sign-in.
 */
export async function isPortalUser(): Promise<boolean> {
  const auth = await getAuthUser();
  if (!auth) return false;
  return (await loadMemberships(auth.id)).length > 0;
}

export async function requirePortalContext(): Promise<PortalContext> {
  const auth = await getAuthUser();
  if (!auth) throw new AppError('UNAUTHENTICATED', 'You must sign in to continue.');

  const memberships = await loadMemberships(auth.id);
  if (memberships.length === 0) {
    throw new AppError('FORBIDDEN', 'This account does not have client portal access.');
  }

  const store = await cookies();
  const requested = store.get(PORTAL_COMPANY_COOKIE)?.value;
  // A cookie naming a company this person cannot see is ignored rather than
  // refused: it is stale far more often than it is an attack, and either way it
  // must not select anything.
  const active =
    memberships.find((m) => m.company_id === requested) ?? memberships[0]!;

  const headerList = await headers();
  const requestId = headerList.get('x-request-id') ?? newRequestId();

  return {
    requestId,
    user: {
      id: auth.id,
      email: active.email,
      fullName: active.full_name,
      contactId: active.contact_id,
    },
    company: {
      id: active.company_id,
      orgId: active.org_id,
      name: active.company_name,
      capabilities: {
        viewInvoices: active.can_view_invoices,
        viewDocuments: active.can_view_documents,
        approveDeliverables: active.can_approve_deliverables,
      },
    },
    companies: memberships.map((m) => ({ id: m.company_id, name: m.company_name })),
  };
}

/** Non-throwing variant, for deciding where to send someone. */
export async function getPortalContext(): Promise<PortalContext | null> {
  try {
    return await requirePortalContext();
  } catch {
    return null;
  }
}

/**
 * Run a query as the portal user.
 *
 * Read-only by default and deliberately so: every portal write goes through an
 * `app.portal_*` function that re-checks authority in SQL, so a route cannot
 * open a writable transaction and update a table directly.
 */
export async function portalQuery<T>(
  ctx: PortalContext,
  fn: Parameters<typeof withTenant<T>>[1],
  options?: { readOnly?: boolean },
): Promise<T> {
  return withTenant<T>(
    { userId: ctx.user.id, orgId: ctx.company.orgId, requestId: ctx.requestId },
    fn,
    { readOnly: options?.readOnly ?? true },
  );
}
