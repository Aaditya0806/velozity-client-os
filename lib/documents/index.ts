/**
 * Document service.
 *
 * Every read path issues a signed URL only after checking the caller's
 * permission, and records the issue in `document_access_log`. Integrity
 * verification compares the stored SHA-256 against the bytes actually
 * retrieved; a mismatch is treated as a security event, not a transient error.
 */
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { likePattern } from '@/lib/db';
import { filters } from '@/lib/db/filters';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import {
  buildStoragePath,
  putObject,
  getObject,
  createSignedUrl,
  assertUploadAcceptable,
  sanitiseFileName,
  sha256Hex,
  SIGNED_URL_TTL_SECONDS,
} from './storage';
import {
  uuid,
  shortText,
  nullableText,
  tags,
  listQuery,
  safeOrderBy,
  paginationMeta,
} from '@/lib/validation/common';
import { logger } from '@/lib/util/logger';

export const DOCUMENT_CATEGORIES = [
  'general',
  'discovery',
  'proposal',
  'contract',
  'executed_contract',
  'invoice',
  'report',
  'deliverable',
  'onboarding',
  'legal',
  'other',
] as const;

export const documentCreateSchema = z.object({
  name: shortText(300),
  description: nullableText(),
  category: z.enum(DOCUMENT_CATEGORIES).default('general'),
  company_id: uuid.nullable().optional(),
  opportunity_id: uuid.nullable().optional(),
  contract_id: uuid.nullable().optional(),
  project_id: uuid.nullable().optional(),
  proposal_version_id: uuid.nullable().optional(),
  is_client_visible: z.boolean().default(false),
  is_confidential: z.boolean().default(false),
  tags,
});

export const DOCUMENT_SORT_COLUMNS = ['name', 'created_at', 'updated_at', 'category'] as const;

export const documentListSchema = listQuery(DOCUMENT_SORT_COLUMNS, 'created_at', {
  company_id: uuid.optional(),
  project_id: uuid.optional(),
  contract_id: uuid.optional(),
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
});

export interface VersionRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  version_no: number;
  sha256: string;
  size_bytes: number;
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
}

export interface UploadInput {
  document: z.infer<typeof documentCreateSchema>;
  file: { name: string; mimeType: string; body: Buffer };
  changeNote?: string | null;
  source?: 'upload' | 'generated' | 'signature_provider' | 'email' | 'import';
  /** Marks the document immutable on creation. Used for executed contracts. */
  immutable?: boolean;
}

export async function uploadDocument(tx: Tx, ctx: RequestContext, input: UploadInput) {
  assertUploadAcceptable(input.file.mimeType, input.file.body.byteLength);

  const document = await tx.one<{ id: string; category: string; company_id: string | null }>(
    `insert into documents (
       org_id, company_id, opportunity_id, contract_id, project_id, proposal_version_id,
       category, name, description, source, is_client_visible, is_confidential, tags, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning id, category, company_id`,
    [
      ctx.org.id,
      input.document.company_id ?? null,
      input.document.opportunity_id ?? null,
      input.document.contract_id ?? null,
      input.document.project_id ?? null,
      input.document.proposal_version_id ?? null,
      input.document.category,
      input.document.name,
      input.document.description ?? null,
      input.source ?? 'upload',
      input.document.is_client_visible,
      input.document.is_confidential,
      input.document.tags,
      ctx.user.id,
    ],
  );

  const version = await addVersion(tx, ctx, document.id, input.file, input.changeNote ?? null);

  // Immutability is applied after the first version exists, because the
  // immutability trigger refuses new versions once the flag is set.
  if (input.immutable) {
    await tx.query(`update documents set is_immutable = true where id = $1`, [document.id]);
  }

  const event = await emitEvent(tx, {
    name: 'document.uploaded',
    entityType: 'document',
    entityId: document.id,
    payload: {
      category: document.category,
      company_id: document.company_id,
      sha256: version.sha256,
      size_bytes: version.size_bytes,
    },
  });

  if (document.company_id) {
    await recordActivity(tx, {
      entityType: 'document',
      entityId: document.id,
      companyId: document.company_id,
      activityType: 'document',
      title: `Document "${input.document.name}" uploaded`,
      eventId: event.id,
    });
  }

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'document.uploaded',
    category: 'document',
    actorUserId: ctx.user.id,
    entityType: 'document',
    entityId: document.id,
    summary: `Uploaded ${input.document.name}`,
    metadata: {
      sha256: version.sha256,
      size_bytes: version.size_bytes,
      immutable: Boolean(input.immutable),
    },
    requestId: ctx.requestId,
  });

  return { documentId: document.id, version };
}

/**
 * Adds a new version.
 *
 * Bytes go to storage first: if that fails there is no database row promising a
 * file that does not exist. If the database insert then fails, the transaction
 * rolls back and the stored object is simply unreferenced - the safe direction
 * to fail in.
 */
export async function addVersion(
  tx: Tx,
  ctx: RequestContext,
  documentId: string,
  file: { name: string; mimeType: string; body: Buffer },
  changeNote: string | null,
): Promise<VersionRow> {
  assertUploadAcceptable(file.mimeType, file.body.byteLength);

  const document = await tx.maybeOne<{
    id: string;
    category: string;
    company_id: string | null;
    is_immutable: boolean;
    version_count: number;
  }>(
    `select id, category, company_id, is_immutable, version_count
     from documents where id = $1 and deleted_at is null for update`,
    [documentId],
  );
  if (!document) throw new AppError('NOT_FOUND', 'This document was not found.');
  if (document.is_immutable) {
    throw new AppError(
      'DOCUMENT_IMMUTABLE',
      'This document is immutable and cannot receive new versions.',
    );
  }

  const versionNo = document.version_count + 1;
  const path = buildStoragePath({
    orgId: ctx.org.id,
    companyId: document.company_id,
    category: document.category,
    documentId,
    versionNo,
    fileName: file.name,
  });

  const stored = await putObject(path, file.body, file.mimeType);

  const version = await tx.one<VersionRow>(
    `insert into document_versions (
       org_id, document_id, version_no, storage_bucket, storage_path, file_name,
       mime_type, size_bytes, sha256, change_note, uploaded_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      ctx.org.id,
      documentId,
      versionNo,
      stored.bucket,
      stored.path,
      sanitiseFileName(file.name),
      file.mimeType,
      stored.sizeBytes,
      stored.sha256,
      changeNote,
      ctx.user.id,
    ],
  );

  await tx.query(
    `insert into document_access_log (org_id, document_id, version_id, user_id, action, request_id)
     values ($1,$2,$3,$4,'uploaded',$5)`,
    [ctx.org.id, documentId, version.id, ctx.user.id, ctx.requestId],
  );

  if (versionNo > 1) {
    await emitEvent(tx, {
      name: 'document.version_added',
      entityType: 'document',
      entityId: documentId,
      payload: { version_no: versionNo, sha256: stored.sha256 },
    });
  }

  return version;
}

/**
 * Issues a signed download URL.
 *
 * RLS has already decided whether this row is visible at all; the extra check
 * here is for confidential documents, which need their own permission even from
 * someone who can otherwise see the client.
 */
export async function issueDownloadUrl(
  tx: Tx,
  ctx: RequestContext,
  documentId: string,
  versionId?: string,
): Promise<{ url: string; expires_at: string; file_name: string; sha256: string }> {
  const document = await tx.maybeOne<{
    id: string;
    name: string;
    is_confidential: boolean;
    status: string;
    current_version_id: string | null;
  }>(
    `select id, name, is_confidential, status, current_version_id
     from documents where id = $1 and deleted_at is null`,
    [documentId],
  );
  if (!document) throw new AppError('NOT_FOUND', 'This document was not found.');

  if (document.status === 'quarantined') {
    throw new AppError(
      'DOCUMENT_HASH_MISMATCH',
      'This document is quarantined after failing an integrity check and cannot be downloaded.',
    );
  }

  if (document.is_confidential && !ctx.permissions.has('document:read_confidential:org')) {
    await writeAudit(tx, {
      orgId: ctx.org.id,
      action: 'document.access_denied',
      category: 'security',
      severity: 'warning',
      actorUserId: ctx.user.id,
      entityType: 'document',
      entityId: documentId,
      summary: `Denied access to confidential document ${document.name}`,
      requestId: ctx.requestId,
    });
    throw new AppError('FORBIDDEN', 'This document is marked confidential.');
  }

  const targetVersion = versionId ?? document.current_version_id;
  if (!targetVersion) throw new AppError('NOT_FOUND', 'This document has no stored file.');

  const version = await tx.maybeOne<VersionRow>(
    `select * from document_versions where id = $1 and document_id = $2`,
    [targetVersion, documentId],
  );
  if (!version) throw new AppError('NOT_FOUND', 'This document version was not found.');

  const signed = await createSignedUrl(version.storage_bucket, version.storage_path, {
    download: version.file_name,
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });

  await tx.query(
    `insert into document_access_log
       (org_id, document_id, version_id, user_id, action, request_id, metadata)
     values ($1,$2,$3,$4,'url_issued',$5,$6)`,
    [
      ctx.org.id,
      documentId,
      version.id,
      ctx.user.id,
      ctx.requestId,
      JSON.stringify({ expires_at: signed.expiresAt }),
    ],
  );

  return {
    url: signed.url,
    expires_at: signed.expiresAt,
    file_name: version.file_name,
    sha256: version.sha256,
  };
}

/**
 * Integrity check.
 *
 * Downloads the stored object and re-hashes it. A mismatch means the bytes in
 * storage are not the bytes we recorded: the document is quarantined, a critical
 * audit record is written, and the caller gets an error rather than the file.
 */
export async function verifyIntegrity(
  tx: Tx,
  ctx: RequestContext,
  versionId: string,
): Promise<{ ok: true; sha256: string }> {
  const version = await tx.one<VersionRow>(
    `select * from document_versions where id = $1`,
    [versionId],
  );

  const bytes = await getObject(version.storage_bucket, version.storage_path);
  const actual = sha256Hex(bytes);

  if (actual !== version.sha256) {
    logger.error('Document hash mismatch', {
      org_id: ctx.org.id,
      document_id: version.document_id,
      version_id: versionId,
      expected: version.sha256,
      actual,
    });

    await tx.query(
      `insert into document_access_log
         (org_id, document_id, version_id, user_id, action, request_id, metadata)
       values ($1,$2,$3,$4,'hash_mismatch',$5,$6)`,
      [
        ctx.org.id,
        version.document_id,
        versionId,
        ctx.user.id,
        ctx.requestId,
        JSON.stringify({ expected: version.sha256, actual }),
      ],
    );

    await tx.query(`update documents set status = 'quarantined' where id = $1`, [
      version.document_id,
    ]);

    await writeAudit(tx, {
      orgId: ctx.org.id,
      action: 'document.hash_mismatch',
      category: 'security',
      severity: 'critical',
      actorUserId: ctx.user.id,
      entityType: 'document',
      entityId: version.document_id,
      summary: 'Stored document failed its integrity check and was quarantined',
      metadata: { version_id: versionId, expected: version.sha256, actual },
      requestId: ctx.requestId,
    });

    await emitEvent(tx, {
      name: 'document.hash_mismatch',
      entityType: 'document',
      entityId: version.document_id,
      payload: { version_id: versionId, expected: version.sha256, actual },
    });

    throw new AppError(
      'DOCUMENT_HASH_MISMATCH',
      'This document failed its integrity check and has been quarantined. A security alert was raised.',
      { details: { document_id: version.document_id, version_id: versionId } },
    );
  }

  await tx.query(
    `insert into document_access_log (org_id, document_id, version_id, user_id, action, request_id)
     values ($1,$2,$3,$4,'hash_verified',$5)`,
    [ctx.org.id, version.document_id, versionId, ctx.user.id, ctx.requestId],
  );

  return { ok: true, sha256: actual };
}

export async function listDocuments(
  tx: Tx,
  _ctx: RequestContext,
  query: z.infer<typeof documentListSchema>,
) {
  const f = filters('d.deleted_at is null');
  if (query.q) {
    const p = likePattern(query.q);
    f.where('(d.name ilike ? or d.description ilike ?)', p, p);
  }
  f.whereIf(query.company_id, 'd.company_id = ?');
  f.whereIf(query.project_id, 'd.project_id = ?');
  f.whereIf(query.contract_id, 'd.contract_id = ?');
  f.whereIf(query.category, 'd.category = ?');

  const totalRow = await tx.one<{ count: string }>(
    `select count(*)::text as count from documents d where ${f.sql}`,
    f.params,
  );

  const order = safeOrderBy(query.sort, query.direction, DOCUMENT_SORT_COLUMNS, 'created_at');
  const limit = f.bind(query.page_size);
  const offset = f.bind((query.page - 1) * query.page_size);

  const rows = await tx.many(
    `select d.*, v.file_name, v.mime_type, v.size_bytes, v.sha256, v.version_no,
            c.name as company_name, u.full_name as created_by_name
     from documents d
     left join document_versions v on v.id = d.current_version_id
     left join companies c on c.id = d.company_id
     left join user_profiles u on u.id = d.created_by
     where ${f.sql}
     order by d.${order}
     limit ${limit} offset ${offset}`,
    f.params,
  );

  return {
    rows,
    pagination: paginationMeta(query.page, query.page_size, Number.parseInt(totalRow.count, 10)),
  };
}

export async function getDocument(tx: Tx, _ctx: RequestContext, id: string) {
  const document = await tx.maybeOne<Record<string, unknown>>(
    `select d.*, c.name as company_name, u.full_name as created_by_name
     from documents d
     left join companies c on c.id = d.company_id
     left join user_profiles u on u.id = d.created_by
     where d.id = $1 and d.deleted_at is null`,
    [id],
  );
  if (!document) throw new AppError('NOT_FOUND', 'This document was not found.');

  const versions = await tx.many(
    `select v.*, u.full_name as uploaded_by_name
     from document_versions v
     left join user_profiles u on u.id = v.uploaded_by
     where v.document_id = $1 order by v.version_no desc`,
    [id],
  );

  return { ...document, versions };
}

/** Soft delete only. An immutable document refuses even this. */
export async function archiveDocument(tx: Tx, ctx: RequestContext, id: string, reason: string) {
  const document = await tx.maybeOne<{ id: string; name: string; is_immutable: boolean }>(
    `select id, name, is_immutable from documents where id = $1 and deleted_at is null for update`,
    [id],
  );
  if (!document) throw new AppError('NOT_FOUND', 'This document was not found.');
  if (document.is_immutable) {
    throw new AppError(
      'DOCUMENT_IMMUTABLE',
      'Executed and other immutable documents cannot be deleted.',
    );
  }

  await tx.query(
    `update documents set deleted_at = now(), deleted_by = $2, status = 'archived' where id = $1`,
    [id, ctx.user.id],
  );

  await tx.query(
    `insert into document_access_log (org_id, document_id, user_id, action, request_id)
     values ($1,$2,$3,'deleted',$4)`,
    [ctx.org.id, id, ctx.user.id, ctx.requestId],
  );

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'document.archived',
    category: 'document',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'document',
    entityId: id,
    summary: `Archived document ${document.name}`,
    reason,
    requestId: ctx.requestId,
  });

  return { id, archived: true };
}

export { buildStoragePath, sanitiseFileName, SIGNED_URL_TTL_SECONDS };
