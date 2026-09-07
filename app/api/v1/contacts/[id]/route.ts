import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok, noContent } from '@/lib/http/response';
import {
  getContact, updateContact, archiveContact, contactUpdateSchema,
} from '@/lib/services/contacts';
import { uuid, meaningfulReason } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['contact:read:own', 'contact:read:team', 'contact:read:org'], params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const contact = await db((tx) => getContact(tx, ctx, id), { readOnly: true });
    return ok(contact, requestId);
  },
);

export const PATCH = route(
  {
    anyPermission: ['contact:update:own', 'contact:update:team', 'contact:update:org'],
    params,
    body: contactUpdateSchema,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const contact = await db((tx) => updateContact(tx, ctx, id, body));
    return ok(contact, requestId);
  },
);

export const DELETE = route(
  {
    anyPermission: ['contact:delete:own', 'contact:delete:team', 'contact:delete:org'],
    params,
    body: z.object({ reason: meaningfulReason }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    await db((tx) => archiveContact(tx, ctx, id, body.reason));
    return noContent(requestId);
  },
);
