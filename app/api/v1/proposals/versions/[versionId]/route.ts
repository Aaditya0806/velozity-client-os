import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { updateVersion, versionUpdateSchema } from '@/lib/services/proposals';
import { uuid } from '@/lib/validation/common';

const params = z.object({ versionId: uuid });

/**
 * Editing a version requires the revision the client last read. A mismatch is a
 * 409 carrying the current content, so the UI can show a conflict rather than
 * silently overwriting a colleague's work.
 */
export const PATCH = route(
  {
    anyPermission: ['proposal:update:own', 'proposal:update:team', 'proposal:update:org'],
    params,
    body: versionUpdateSchema,
  },
  async ({ ctx, params: { versionId }, body, db, requestId }) => {
    const version = await db((tx) => updateVersion(tx, ctx, versionId, body));
    return ok(version, requestId);
  },
);
