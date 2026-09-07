/**
 * Signature requests.
 *
 * Sending a contract for signature is the most consequential outward action in
 * the product, so it is fenced accordingly:
 *
 *   - `contract:send:org` is required, and is a different authority from
 *     approving the contract or owning the deal;
 *   - the contract must already be `approved_to_send`;
 *   - the document hash is captured before it leaves us, so the executed copy
 *     can be reasoned about afterwards;
 *   - the endpoint is idempotent, so a retried send does not create a second
 *     request at the provider.
 */
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/auth/session';
import { performTransition } from '@/lib/workflows/state-machine';
import { contractMachine } from '@/lib/workflows/machines';
import { getSignatureProvider, type Signer } from '@/lib/signature';
import { getObject } from '@/lib/documents/storage';
import { logger } from '@/lib/util/logger';

export interface SendForSignatureInput {
  contractId: string;
  subject?: string;
  message?: string;
  expiresInDays?: number;
  idempotencyKey?: string;
  provider?: string;
}

export async function sendForSignature(
  tx: Tx,
  ctx: RequestContext,
  input: SendForSignatureInput,
) {
  ctx.permissions.require(
    'contract:send:org',
    'Sending a contract for signature requires send authority, which is separate from deal ownership.',
  );

  const contract = await tx.maybeOne<{
    id: string; reference: string; title: string; status: string; company_id: string;
    draft_document_id: string | null; contract_type: string;
  }>(
    `select id, reference, title, status, company_id, draft_document_id, contract_type
     from contracts where id = $1 and deleted_at is null for update`,
    [input.contractId],
  );
  if (!contract) throw new AppError('NOT_FOUND', 'This contract was not found.');

  if (contract.status !== 'approved_to_send') {
    throw new AppError(
      'CONTRACT_NOT_APPROVED',
      'This contract must be approved by legal before it can be sent.',
      { details: { current_status: contract.status } },
    );
  }

  if (!contract.draft_document_id) {
    throw new AppError(
      'INVALID_STATE',
      'This contract has no rendered document to send.',
    );
  }

  // An earlier attempt with the same key already reached the provider.
  if (input.idempotencyKey) {
    const existing = await tx.maybeOne<{ id: string; provider_request_id: string | null }>(
      `select id, provider_request_id from signature_requests
       where org_id = $1 and idempotency_key = $2`,
      [ctx.org.id, input.idempotencyKey],
    );
    if (existing) {
      return { signatureRequestId: existing.id, providerRequestId: existing.provider_request_id, replayed: true };
    }
  }

  const signerRows = await tx.many<{
    id: string; party: 'internal' | 'counterparty' | 'witness';
    name: string; email: string; role_label: string | null; signing_order: number;
  }>(
    `select id, party, name, email, role_label, signing_order
     from contract_signers where contract_id = $1 order by signing_order`,
    [input.contractId],
  );

  if (signerRows.length < 2) {
    throw new AppError(
      'INVALID_STATE',
      'A contract needs at least one signer from each side before it can be sent.',
    );
  }

  const version = await tx.one<{
    id: string; storage_bucket: string; storage_path: string;
    file_name: string; mime_type: string; sha256: string;
  }>(
    `select v.id, v.storage_bucket, v.storage_path, v.file_name, v.mime_type, v.sha256
     from document_versions v
     join documents d on d.id = v.document_id
     where d.id = $1 and v.id = d.current_version_id`,
    [contract.draft_document_id],
  );

  const bytes = await getObject(version.storage_bucket, version.storage_path);
  const provider = getSignatureProvider(input.provider);

  const signers: Signer[] = signerRows.map((s) => ({
    name: s.name,
    email: s.email,
    order: s.signing_order,
    role: s.role_label ?? undefined,
    party: s.party,
  }));

  // The database row is written first, so a provider call that succeeds but
  // whose response is lost still has a local record to reconcile against.
  const request = await tx.one<{ id: string }>(
    `insert into signature_requests (
       org_id, contract_id, provider, status, document_version_id, sent_sha256,
       subject, message, expires_at, idempotency_key, requested_by
     ) values ($1,$2,$3,'created',$4,$5,$6,$7, now() + make_interval(days => $8), $9, $10)
     returning id`,
    [
      ctx.org.id, input.contractId, provider.name, version.id, version.sha256,
      input.subject ?? `${contract.reference} — ${contract.title}`,
      input.message ?? null, input.expiresInDays ?? 30,
      input.idempotencyKey ?? null, ctx.user.id,
    ],
  );

  let providerRequest;
  try {
    providerRequest = await provider.createRequest(
      {
        name: version.file_name,
        mimeType: version.mime_type,
        content: bytes,
        sha256: version.sha256,
      },
      signers,
      {
        subject: input.subject ?? `${contract.reference} — ${contract.title}`,
        message: input.message,
        expiresInDays: input.expiresInDays ?? 30,
        referenceId: contract.reference,
      },
    );
  } catch (error) {
    // Record the failure against the request so an operator can see what
    // happened, then surface it. The contract stays approved_to_send and can be
    // retried; nothing has been told to the client.
    await tx.query(
      `update signature_requests set status = 'failed', last_error = $2 where id = $1`,
      [request.id, error instanceof Error ? error.message : String(error)],
    );
    await writeAudit(tx, {
      orgId: ctx.org.id,
      action: 'contract.send_failed',
      category: 'contract',
      severity: 'warning',
      actorUserId: ctx.user.id,
      entityType: 'contract',
      entityId: input.contractId,
      summary: `Signature provider rejected the send of ${contract.reference}`,
      metadata: { provider: provider.name, error: error instanceof Error ? error.message : String(error) },
      requestId: ctx.requestId,
    });
    throw error;
  }

  await tx.query(
    `update signature_requests
     set provider_request_id = $2, status = $3, provider_metadata = $4
     where id = $1`,
    [
      request.id,
      providerRequest.providerRequestId,
      providerRequest.status,
      JSON.stringify(providerRequest.raw ?? {}),
    ],
  );

  for (const [email, providerSignerId] of Object.entries(providerRequest.signerIds ?? {})) {
    await tx.query(
      `update contract_signers set provider_signer_id = $3, status = 'sent'
       where contract_id = $1 and lower(email) = $2`,
      [input.contractId, email.toLowerCase(), providerSignerId],
    );
  }

  const transition = await performTransition(
    tx,
    contractMachine,
    input.contractId,
    { to: 'sent', payload: { signature_request_id: request.id } },
    { userId: ctx.user.id },
  );

  const event = await emitEvent(tx, {
    name: 'contract.sent',
    entityType: 'contract',
    entityId: input.contractId,
    payload: {
      reference: contract.reference,
      contract_type: contract.contract_type,
      provider: provider.name,
      provider_request_id: providerRequest.providerRequestId,
      signers: signers.map((s) => s.email),
    },
  });

  await recordActivity(tx, {
    entityType: 'contract',
    entityId: input.contractId,
    companyId: contract.company_id,
    activityType: 'contract',
    title: `${contract.reference} sent for signature`,
    body: signers.map((s) => s.email).join(', '),
    eventId: event.id,
  });

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'contract.sent',
    category: 'contract',
    severity: 'notice',
    actorUserId: ctx.user.id,
    entityType: 'contract',
    entityId: input.contractId,
    summary: `Sent ${contract.reference} for signature via ${provider.name}`,
    metadata: {
      provider_request_id: providerRequest.providerRequestId,
      sent_sha256: version.sha256,
      signers: signers.map((s) => ({ email: s.email, party: s.party })),
    },
    requestId: ctx.requestId,
  });

  logger.info('Contract sent for signature', {
    org_id: ctx.org.id,
    request_id: ctx.requestId,
    contract_id: input.contractId,
    provider: provider.name,
  });

  return {
    signatureRequestId: request.id,
    providerRequestId: providerRequest.providerRequestId,
    status: transition.to,
    replayed: false,
  };
}

export async function voidSignatureRequest(
  tx: Tx,
  ctx: RequestContext,
  signatureRequestId: string,
  reason: string,
) {
  ctx.permissions.require('contract:void:org');

  const request = await tx.one<{
    id: string; contract_id: string; provider: string; provider_request_id: string | null;
  }>(
    `select id, contract_id, provider, provider_request_id
     from signature_requests where id = $1 for update`,
    [signatureRequestId],
  );

  if (request.provider_request_id) {
    const provider = getSignatureProvider(request.provider);
    await provider.void(request.provider_request_id, reason);
  }

  await tx.query(
    `update signature_requests set status = 'voided' where id = $1`,
    [signatureRequestId],
  );

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'signature_request.voided',
    category: 'contract',
    severity: 'warning',
    actorUserId: ctx.user.id,
    entityType: 'signature_request',
    entityId: signatureRequestId,
    summary: 'Voided a signature request with the provider',
    reason,
    requestId: ctx.requestId,
  });

  return { signatureRequestId, voided: true };
}
