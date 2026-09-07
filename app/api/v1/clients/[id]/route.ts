import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok, noContent } from '@/lib/http/response';
import {
  getCompany, updateCompany, archiveCompany, companyUpdateSchema,
} from '@/lib/services/companies';
import { uuid, meaningfulReason } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['company:read:own', 'company:read:team', 'company:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const company = await db((tx) => getCompany(tx, ctx, id), { readOnly: true });
    return ok(company, requestId);
  },
);

export const PATCH = route(
  {
    anyPermission: ['company:update:own', 'company:update:team', 'company:update:org'],
    params,
    body: companyUpdateSchema,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const company = await db((tx) => updateCompany(tx, ctx, id, body));
    return ok(company, requestId);
  },
);

// Archive, not delete. Critical business data is never removed.
export const DELETE = route(
  {
    anyPermission: ['company:delete:own', 'company:delete:team', 'company:delete:org'],
    params,
    body: z.object({ reason: meaningfulReason }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    await db((tx) => archiveCompany(tx, ctx, id, body.reason));
    return noContent(requestId);
  },
);
