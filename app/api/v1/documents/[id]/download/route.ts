import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { issueDownloadUrl, verifyIntegrity } from '@/lib/documents';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });
const query = z.object({
  version_id: uuid.optional(),
  /**
   * Re-hashes the stored bytes before issuing the link. Slower, and worth it for
   * anything legally significant.
   */
  verify: z.enum(['true', 'false']).optional(),
});

/**
 * Issues a signed URL valid for 15 minutes.
 *
 * Permission is checked before the link exists, and the issue is recorded in
 * document_access_log. A quarantined document is refused outright.
 */
export const GET = route(
  { permission: 'document:read:org', params, query },
  async ({ ctx, params: { id }, query: q, db, requestId }) => {
    const result = await db(async (tx) => {
      if (q.verify === 'true') {
        const versionId =
          q.version_id ??
          (
            await tx.one<{ current_version_id: string }>(
              'select current_version_id from documents where id = $1',
              [id],
            )
          ).current_version_id;
        await verifyIntegrity(tx, ctx, versionId);
      }
      return issueDownloadUrl(tx, ctx, id, q.version_id);
    });
    return ok(result, requestId);
  },
);
