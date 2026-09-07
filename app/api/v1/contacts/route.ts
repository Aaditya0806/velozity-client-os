import { route } from '@/lib/http/api';
import { created, paginated } from '@/lib/http/response';
import {
  listContacts, createContact, contactCreateSchema, contactListSchema,
} from '@/lib/services/contacts';

export const GET = route(
  {
    anyPermission: ['contact:read:own', 'contact:read:team', 'contact:read:org'],
    query: contactListSchema,
  },
  async ({ ctx, query, db, requestId }) => {
    const result = await db((tx) => listContacts(tx, ctx, query), { readOnly: true });
    return paginated(result.rows, result.pagination, requestId);
  },
);

export const POST = route(
  { permission: 'contact:create:org', body: contactCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const contact = await db((tx) => createContact(tx, ctx, body));
    return created(contact, requestId, `/api/v1/contacts/${contact.id}`);
  },
);
