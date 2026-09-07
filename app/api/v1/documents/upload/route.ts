import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { uploadDocument, documentCreateSchema } from '@/lib/documents';
import { MAX_UPLOAD_BYTES } from '@/lib/documents/storage';
import { AppError } from '@/lib/http/errors';

/**
 * Multipart upload.
 *
 * The body is not JSON, so this route parses the form itself rather than using
 * the wrapper's body schema, then validates the metadata with the same schema
 * the JSON routes use.
 */
export const POST = route(
  { permission: 'document:create:org' },
  async ({ req, ctx, db, requestId }) => {
    const form = await req.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      throw new AppError('VALIDATION_ERROR', 'A file is required.', {
        details: { field: 'file' },
      });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppError('VALIDATION_ERROR', 'This file exceeds the 50 MB upload limit.');
    }

    const rawMetadata = form.get('metadata');
    const parsed = documentCreateSchema.safeParse(
      typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : { name: file.name },
    );
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid document metadata.', {
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      });
    }

    const body = Buffer.from(await file.arrayBuffer());

    const result = await db((tx) =>
      uploadDocument(tx, ctx, {
        document: parsed.data,
        file: {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          body,
        },
      }),
    );

    return created(
      { document_id: result.documentId, version: result.version },
      requestId,
      `/api/v1/documents/${result.documentId}`,
    );
  },
);

