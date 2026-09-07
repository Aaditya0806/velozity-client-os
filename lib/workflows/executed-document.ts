/**
 * Storing an executed contract.
 *
 * This is the step that turns "the provider says everyone signed" into a fact
 * the business can rely on. The order matters:
 *
 *   1. download the executed file from the provider;
 *   2. compute its SHA-256 ourselves — we never take the provider's word;
 *   3. store it as an immutable document;
 *   4. only then move the contract to `fully_executed`.
 *
 * If any step fails the contract stays where it is and the job retries. There is
 * no state in which a contract is marked executed without its executed document
 * — the database refuses that combination outright.
 */
import { withService } from '@/lib/db';
import { getSignatureProvider } from '@/lib/signature';
import { putObject, buildStoragePath, sha256Hex } from '@/lib/documents/storage';
import { performTransition } from './state-machine';
import { contractMachine } from './machines';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

/**
 * This work is performed by the signature provider, not by a person. Actor
 * columns are therefore NULL and `actor_type` carries the attribution - rather
 * than inventing a synthetic system user that every foreign key would have to
 * be taught about.
 */
const SYSTEM_ACTOR = null;

export interface DownloadExecutedInput {
  signatureRequestId: string;
  contractId: string;
}

export async function downloadAndStoreExecutedDocument(
  input: DownloadExecutedInput,
): Promise<{ documentId: string; sha256: string }> {
  // The provider call happens outside the transaction: it is slow, it is
  // external, and holding a database transaction across it would be wrong.
  const request = await withService('load signature request for executed download', (tx) =>
    tx.one<{
      id: string; org_id: string; contract_id: string; provider: string;
      provider_request_id: string | null; sent_sha256: string | null;
    }>(
      `select id, org_id, contract_id, provider, provider_request_id, sent_sha256
       from signature_requests where id = $1`,
      [input.signatureRequestId],
    ),
  );

  if (!request.provider_request_id) {
    throw new AppError(
      'PROVIDER_ERROR',
      'This signature request has no provider reference, so the executed document cannot be retrieved.',
    );
  }

  const provider = getSignatureProvider(request.provider);
  const bytes = await provider.downloadExecuted(request.provider_request_id);

  if (bytes.byteLength === 0) {
    throw new AppError('PROVIDER_ERROR', 'The signature provider returned an empty document.');
  }

  // Our hash, of our bytes, computed before storage. It is compared against what
  // the storage layer reports below: if those two ever disagree, the bytes
  // changed in transit and the document must not be sealed.
  const expectedSha256 = sha256Hex(bytes);

  return withService('store executed contract', async (tx) => {
    await tx.bindOrg(request.org_id);

    const contract = await tx.one<{
      id: string; reference: string; title: string; company_id: string;
      contract_type: string; status: string; owner_user_id: string | null;
      opportunity_id: string | null; executed_document_id: string | null;
    }>(
      `select id, reference, title, company_id, contract_type, status, owner_user_id,
              opportunity_id, executed_document_id
       from contracts where id = $1 for update`,
      [input.contractId],
    );

    // Already done. A retried job must not create a second executed document.
    if (contract.executed_document_id) {
      const existing = await tx.one<{ sha256: string }>(
        `select v.sha256 from documents d
         join document_versions v on v.id = d.current_version_id
         where d.id = $1`,
        [contract.executed_document_id],
      );
      logger.info('Executed document already stored', {
        contract_id: contract.id,
        document_id: contract.executed_document_id,
      });
      return { documentId: contract.executed_document_id, sha256: existing.sha256 };
    }

    const document = await tx.one<{ id: string }>(
      `insert into documents (
         org_id, company_id, contract_id, opportunity_id, category, name, description,
         source, is_client_visible, is_confidential, tags, created_by
       ) values ($1,$2,$3,$4,'executed_contract',$5,$6,'signature_provider',true,true,$7,$8)
       returning id`,
      [
        request.org_id, contract.company_id, contract.id, contract.opportunity_id,
        `${contract.reference} — executed`,
        `Executed ${contract.contract_type.toUpperCase()} retrieved from ${request.provider}`,
        ['executed', 'contract', contract.contract_type],
        SYSTEM_ACTOR,
      ],
    );

    const path = buildStoragePath({
      orgId: request.org_id,
      companyId: contract.company_id,
      category: 'executed_contract',
      documentId: document.id,
      versionNo: 1,
      fileName: `${contract.reference}-executed.pdf`,
    });

    const stored = await putObject(path, bytes, 'application/pdf');

    if (stored.sha256 !== expectedSha256) {
      throw new AppError(
        'DOCUMENT_HASH_MISMATCH',
        'The executed document changed between download and storage. It has not been sealed.',
        { details: { expected: expectedSha256, stored: stored.sha256 } },
      );
    }

    const version = await tx.one<{ id: string }>(
      `insert into document_versions (
         org_id, document_id, version_no, storage_bucket, storage_path, file_name,
         mime_type, size_bytes, sha256, change_note, uploaded_by
       ) values ($1,$2,1,$3,$4,$5,'application/pdf',$6,$7,$8,$9)
       returning id`,
      [
        request.org_id, document.id, stored.bucket, stored.path,
        `${contract.reference}-executed.pdf`, stored.sizeBytes, stored.sha256,
        `Executed copy retrieved from ${request.provider}`, SYSTEM_ACTOR,
      ],
    );

    // Sealed. From here the document accepts no new versions, no edits and no
    // deletion — enforced by trigger, not convention.
    await tx.query(`update documents set is_immutable = true where id = $1`, [document.id]);

    await tx.query(
      `insert into document_access_log (org_id, document_id, version_id, action, metadata)
       values ($1,$2,$3,'uploaded',$4)`,
      [
        request.org_id, document.id, version.id,
        JSON.stringify({ source: request.provider, sha256: stored.sha256 }),
      ],
    );

    const transition = await performTransition(
      tx,
      contractMachine,
      contract.id,
      {
        to: 'fully_executed',
        reason: 'All parties signed; executed document retrieved and stored.',
        payload: { executed_document_id: document.id },
      },
      { userId: SYSTEM_ACTOR, actorType: 'provider' },
    );

    const event = await emitEvent(
      tx,
      {
        name: 'contract.executed',
        entityType: 'contract',
        entityId: contract.id,
        payload: {
          reference: contract.reference,
          contract_type: contract.contract_type,
          company_id: contract.company_id,
          opportunity_id: contract.opportunity_id,
          executed_document_id: document.id,
          sha256: stored.sha256,
        },
        actorType: 'provider',
        actorUserId: null,
      },
    );

    await recordActivity(tx, {
      entityType: 'contract',
      entityId: contract.id,
      companyId: contract.company_id,
      activityType: 'contract',
      title: `${contract.reference} fully executed`,
      body: 'The executed copy has been stored and sealed.',
      actorType: 'provider',
      actorUserId: null,
      eventId: event.id,
    });

    await writeAudit(tx, {
      orgId: request.org_id,
      action: 'contract.executed',
      category: 'contract',
      severity: 'notice',
      actorType: 'provider',
      actorLabel: request.provider,
      entityType: 'contract',
      entityId: contract.id,
      summary: `${contract.reference} fully executed and sealed`,
      after: {
        status: 'fully_executed',
        executed_document_id: document.id,
        sha256: stored.sha256,
      },
      metadata: {
        sent_sha256: request.sent_sha256,
        executed_sha256: stored.sha256,
        // These differ for a real provider, which stamps signature blocks onto
        // the file. Both are recorded so the pair can be reconciled later.
        provider: request.provider,
      },
    });

    if (contract.owner_user_id) {
      await notify(tx, {
        userId: contract.owner_user_id,
        category: 'contract',
        title: 'Contract fully executed',
        body: `${contract.reference} has been signed by all parties.`,
        entityType: 'contract',
        entityId: contract.id,
        linkUrl: `/legal/contracts/${contract.id}`,
        priority: 'high',
        dedupeKey: `contract-executed:${contract.id}`,
      });
    }

    // Execution may have satisfied a legal gate. Re-evaluate the onboarding
    // rather than assuming, so the unblock is driven by the same rule as always.
    await tx.query(
      `insert into jobs (org_id, queue, job_type, payload, priority, singleton_key)
       select $1, 'default', 'onboarding.evaluate_gate',
              jsonb_build_object('onboarding_id', o.id), 20,
              'evaluate-gate:' || o.id
       from onboardings o
       where o.company_id = $2 and o.status = 'blocked' and o.deleted_at is null
       on conflict (singleton_key) where singleton_key is not null and status in ('queued','running')
       do nothing`,
      [request.org_id, contract.company_id],
    );

    void transition;
    logger.info('Executed contract stored', {
      org_id: request.org_id,
      contract_id: contract.id,
      document_id: document.id,
      sha256: stored.sha256,
    });

    return { documentId: document.id, sha256: stored.sha256 };
  });
}
