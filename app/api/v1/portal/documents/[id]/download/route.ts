import { z } from 'zod';
import { portalRoute } from '@/lib/http/portal-api';
import { ok } from '@/lib/http/response';
import { uuid } from '@/lib/validation/common';
import { createSignedUrl } from '@/lib/documents/storage';

const params = z.object({ id: uuid });

/**
 * Issues a short-lived signed URL for a document the client may see.
 *
 * Entitlement, the confidential flag, the client-visible flag and the access log
 * are all handled by `app.portal_document_for_download`. This route only turns
 * the storage handle it returns into a link, and the storage path never reaches
 * the browser.
 */
export const GET = portalRoute(
  { capability: 'viewDocuments', params },
  async ({ params: { id }, db, requestId }) => {
    const row = await db(
      (tx) =>
        tx.one<{
          result: {
            storage_bucket: string;
            storage_path: string;
            file_name: string;
            sha256: string;
          };
        }>(`select app.portal_document_for_download($1) as result`, [id]),
      { writable: true },
    );

    const signed = await createSignedUrl(row.result.storage_bucket, row.result.storage_path, {
      download: row.result.file_name,
      expiresIn: 900,
    });

    return ok(
      {
        url: signed.url,
        expires_at: signed.expiresAt,
        file_name: row.result.file_name,
        sha256: row.result.sha256,
      },
      requestId,
    );
  },
);
