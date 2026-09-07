/**
 * Document storage.
 *
 * Files live in a private Supabase Storage bucket and are reachable only through
 * short-lived signed URLs issued after a permission check. The database holds
 * the SHA-256 of every byte stream ever stored, so a download can be verified
 * against what was written - and a mismatch raises a security alert rather than
 * quietly handing over a file that has changed.
 *
 * Nothing is ever overwritten. A new upload is a new version at a new path.
 */
import 'server-only';
import { createSupabaseServiceClient } from '@/lib/auth/supabase';
import { serverEnv } from '@/lib/config/env';
import { sha256Hex } from '@/lib/util/ids';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

/** Signed URLs are deliberately short-lived. */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

export interface StoragePathParts {
  orgId: string;
  companyId: string | null;
  category: string;
  documentId: string;
  versionNo: number;
  fileName: string;
}

/**
 * orgs/{org_id}/clients/{company_id}/{category}/{document_id}/v{n}/{filename}
 *
 * The organisation is the first path segment so a storage-level policy can be
 * written against it, and the version number is in the path so two versions can
 * never collide on one object.
 */
export function buildStoragePath(parts: StoragePathParts): string {
  const safeName = sanitiseFileName(parts.fileName);
  const client = parts.companyId ?? 'unassigned';
  return [
    'orgs',
    parts.orgId,
    'clients',
    client,
    parts.category,
    parts.documentId,
    `v${parts.versionNo}`,
    safeName,
  ].join('/');
}

/**
 * Strips path separators, control characters and leading dots.
 *
 * A filename arrives from a user and is concatenated into a storage path, so it
 * must never be able to escape its directory or smuggle a control character
 * into a Content-Disposition header.
 */
export function sanitiseFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned.length > 0 ? cleaned : 'file';
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/zip',
  'application/json',
]);

/**
 * SVG is deliberately absent from the allow-list: it can carry script, and these
 * files are served from a signed URL on a storage origin.
 */
export function assertUploadAcceptable(mimeType: string, sizeBytes: number): void {
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'This file exceeds the 50 MB upload limit.', {
      details: { size_bytes: sizeBytes, max_bytes: MAX_UPLOAD_BYTES },
    });
  }
  if (sizeBytes === 0) {
    throw new AppError('VALIDATION_ERROR', 'The file is empty.');
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new AppError('VALIDATION_ERROR', `Files of type ${mimeType} are not accepted.`, {
      details: { allowed: [...ALLOWED_MIME_TYPES] },
    });
  }
}

export interface StoredObject {
  bucket: string;
  path: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Writes bytes to storage. The hash is computed here, from the exact buffer
 * uploaded, and returned for the caller to persist alongside the version row.
 */
export async function putObject(
  path: string,
  body: Buffer,
  mimeType: string,
): Promise<StoredObject> {
  const env = serverEnv();
  const bucket = env.SUPABASE_STORAGE_BUCKET;
  const client = createSupabaseServiceClient();

  const { error } = await client.storage.from(bucket).upload(path, body, {
    contentType: mimeType,
    // Never overwrite. A collision means a bug in path construction, and failing
    // loudly is better than losing a stored document.
    upsert: false,
  });

  if (error) {
    logger.error('Storage upload failed', { path, error });
    throw new AppError('PROVIDER_ERROR', 'The file could not be stored.', { cause: error });
  }

  return { bucket, path, sha256: sha256Hex(body), sizeBytes: body.byteLength };
}

export async function getObject(bucket: string, path: string): Promise<Buffer> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) {
    logger.error('Storage download failed', { path, error });
    throw new AppError('PROVIDER_ERROR', 'The file could not be retrieved.', { cause: error });
  }
  return Buffer.from(await data.arrayBuffer());
}

export async function createSignedUrl(
  bucket: string,
  path: string,
  options: { download?: string; expiresIn?: number } = {},
): Promise<{ url: string; expiresAt: string }> {
  const client = createSupabaseServiceClient();
  const expiresIn = options.expiresIn ?? SIGNED_URL_TTL_SECONDS;

  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn, options.download ? { download: options.download } : undefined);

  if (error || !data?.signedUrl) {
    logger.error('Signed URL creation failed', { path, error });
    throw new AppError('PROVIDER_ERROR', 'A download link could not be created.', { cause: error });
  }

  return {
    url: data.signedUrl,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export { sha256Hex };
