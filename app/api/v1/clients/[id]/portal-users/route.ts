import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok, created } from '@/lib/http/response';
import { uuid } from '@/lib/validation/common';
import { provisionAuthUser, createPortalInviteLink } from '@/lib/portal/provision';
import { writeAudit } from '@/lib/audit';
import { AppError } from '@/lib/http/errors';

const params = z.object({ id: uuid });

const body = z.object({
  contact_id: uuid,
  can_view_invoices: z.boolean().default(false),
  can_view_documents: z.boolean().default(true),
  can_approve_deliverables: z.boolean().default(false),
});

interface PortalUserRow {
  id: string;
  status: string;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  can_view_invoices: boolean;
  can_view_documents: boolean;
  can_approve_deliverables: boolean;
  invited_at: string | null;
  last_login_at: string | null;
  revoked_at: string | null;
}

export const GET = route(
  {
    anyPermission: ['company:read:own', 'company:read:team', 'company:read:org'],
    params,
  },
  async ({ params: { id }, db, requestId }) => {
    const rows = await db(
      (tx) =>
        tx.many<PortalUserRow>(
          `select pu.id, pu.status, pu.contact_id,
                  ct.full_name as contact_name, ct.email as contact_email,
                  pu.can_view_invoices, pu.can_view_documents, pu.can_approve_deliverables,
                  pu.invited_at, pu.last_login_at, pu.revoked_at
             from portal_users pu
             join contacts ct on ct.id = pu.contact_id
            where pu.company_id = $1
            order by ct.full_name`,
          [id],
        ),
      { readOnly: true },
    );

    return ok({ portal_users: rows }, requestId);
  },
);

/**
 * Grants a contact access to their company's portal.
 *
 * Three steps in a deliberate order: read the contact under the caller's own
 * RLS, create the auth identity, then let `app.grant_portal_access` decide
 * whether the caller was entitled to any of it. The permission check is last
 * because it is the one that must be authoritative — the route's own
 * `company:update` check is a courtesy that saves a wasted round trip.
 */
export const POST = route(
  {
    anyPermission: ['company:update:own', 'company:update:team', 'company:update:org'],
    params,
    body,
  },
  async ({ ctx, params: { id }, body: input, db, requestId }) => {
    const contact = await db(
      (tx) =>
        tx.maybeOne<{ id: string; email: string | null; full_name: string; company_id: string }>(
          `select id, email, full_name, company_id
             from contacts
            where id = $1 and company_id = $2 and deleted_at is null`,
          [input.contact_id, id],
        ),
      { readOnly: true },
    );

    if (!contact) throw new AppError('NOT_FOUND', 'That contact was not found for this client.');
    if (!contact.email) {
      throw new AppError(
        'VALIDATION_ERROR',
        'This contact has no email address, so they have nothing to sign in with.',
      );
    }

    const authUserId = await provisionAuthUser(contact.email, contact.full_name);

    const result = await db(async (tx) => {
      const row = await tx.one<{ result: { id: string } }>(
        `select app.grant_portal_access($1, $2, $3, $4, $5) as result`,
        [
          contact.id,
          authUserId,
          input.can_view_invoices,
          input.can_view_documents,
          input.can_approve_deliverables,
        ],
      );

      await writeAudit(tx, {
        orgId: ctx.org.id,
        action: 'portal.access_granted',
        category: 'security',
        actorUserId: ctx.user.id,
        entityType: 'company',
        entityId: id,
        summary: `Granted portal access to ${contact.full_name}`,
        metadata: {
          contact_id: contact.id,
          can_view_invoices: input.can_view_invoices,
          can_view_documents: input.can_view_documents,
          can_approve_deliverables: input.can_approve_deliverables,
        },
        requestId,
      });

      return row.result;
    });

    // Best effort, and separate: access has already been granted, and failing
    // the whole request because a convenience link could not be minted would
    // leave the caller unsure whether it worked.
    const inviteLink = await createPortalInviteLink(contact.email).catch(() => null);

    return created({ portal_user: result, invite_link: inviteLink }, requestId);
  },
);
