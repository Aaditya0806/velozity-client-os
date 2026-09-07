import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok, noContent } from '@/lib/http/response';
import { getDocument, archiveDocument } from '@/lib/documents';
import { uuid, meaningfulReason } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { permission: 'document:read:org', params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const document = await db((tx) => getDocument(tx, ctx, id), { readOnly: true });
    return ok(document, requestId);
  },
);

export const DELETE = route(
  {
    permission: 'document:delete:org',
    params,
    body: z.object({ reason: meaningfulReason }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    await db((tx) => archiveDocument(tx, ctx, id, body.reason));
    return noContent(requestId);
  },
);
