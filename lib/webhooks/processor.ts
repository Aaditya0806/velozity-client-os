/**
 * Webhook ingestion and processing.
 *
 * The order of operations is the whole design:
 *
 *   1. read the raw body exactly once;
 *   2. verify the signature;
 *   3. STORE the event — verified or not — before interpreting anything;
 *   4. reject unverified events without processing them;
 *   5. process idempotently on (provider, provider_event_id);
 *   6. retry failures with exponential backoff.
 *
 * Step 3 before step 4 is deliberate: a spoofed or malformed delivery is
 * evidence, and evidence is worth keeping. Step 4 before step 5 is what
 * guarantees an unverified webhook can never mark a contract executed.
 */
import { withService, type Tx } from '@/lib/db';
import { getSignatureProvider, type SignatureEvent } from '@/lib/signature';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import { logger } from '@/lib/util/logger';
import { backoffSeconds } from '@/lib/jobs/queue';
import { AppError } from '@/lib/http/errors';

export interface IngestResult {
  webhookEventId: string;
  accepted: boolean;
  reason?: string;
  duplicate?: boolean;
}

/**
 * Stores an inbound webhook. Always returns 2xx-able unless storage itself
 * fails: a provider that receives a 500 will retry, and we would rather accept
 * and reject internally than have a provider give up on a real event.
 */
export async function ingestWebhook(
  providerName: string,
  rawBody: Buffer,
  headers: Headers,
  requestId: string,
): Promise<IngestResult> {
  const provider = getSignatureProvider(providerName);
  const verification = provider.verifyWebhook(rawBody, headers);

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = null;
  }

  const events = verification.valid && payload ? provider.parseWebhook(payload) : [];
  const first = events[0];

  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    // Signature headers are recorded so a verification failure can be
    // investigated; nothing here is a credential.
    headerRecord[key] = key.toLowerCase().includes('cookie') ? '[redacted]' : value;
  });

  return withService('store inbound signature webhook', async (tx) => {
    // Idempotency at the storage layer: a redelivery of a known event id is
    // recognised before any processing is attempted.
    if (first?.providerEventId) {
      const existing = await tx.maybeOne<{ id: string; status: string }>(
        `select id, status from webhook_events
         where provider = $1 and provider_event_id = $2`,
        [providerName, first.providerEventId],
      );
      if (existing) {
        logger.info('Duplicate webhook ignored', {
          request_id: requestId,
          provider: providerName,
          provider_event_id: first.providerEventId,
        });
        return { webhookEventId: existing.id, accepted: true, duplicate: true };
      }
    }

    const stored = await tx.one<{ id: string }>(
      `insert into webhook_events (
         provider, provider_event_id, event_type, signature_verified, verification_error,
         raw_body, headers, payload, status, next_attempt_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       returning id`,
      [
        providerName,
        first?.providerEventId ?? null,
        first?.type ?? null,
        verification.valid,
        verification.valid ? null : (verification.reason ?? 'unknown'),
        rawBody.toString('utf8').slice(0, 1_000_000),
        JSON.stringify(headerRecord),
        payload ? JSON.stringify(payload) : null,
        verification.valid ? 'received' : 'rejected',
      ],
    );

    if (!verification.valid) {
      // A failed signature is a security event, not a bad request.
      logger.warn('Webhook signature verification failed', {
        request_id: requestId,
        provider: providerName,
        reason: verification.reason,
        webhook_event_id: stored.id,
      });

      await writeAudit(tx, {
        orgId: null,
        action: 'webhook.signature_invalid',
        category: 'security',
        severity: 'critical',
        actorType: 'provider',
        actorLabel: providerName,
        entityType: 'webhook_event',
        entityId: null,
        summary: `Rejected an unverified ${providerName} webhook`,
        metadata: { reason: verification.reason, webhook_event_id: stored.id },
        requestId,
      });

      return { webhookEventId: stored.id, accepted: false, reason: verification.reason };
    }

    return { webhookEventId: stored.id, accepted: true };
  });
}

/**
 * Processes one stored webhook. Called by the worker, never inline with the
 * HTTP request, so a slow provider callback cannot block ingestion.
 */
export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  await withService('process signature webhook', async (tx) => {
    const stored = await tx.maybeOne<{
      id: string; provider: string; payload: unknown; signature_verified: boolean;
      status: string; attempts: number; max_attempts: number;
    }>(
      `select id, provider, payload, signature_verified, status, attempts, max_attempts
       from webhook_events where id = $1 for update`,
      [webhookEventId],
    );

    if (!stored) return;
    if (stored.status === 'processed' || stored.status === 'ignored') return;

    // The load-bearing check. Nothing unverified is ever interpreted.
    if (!stored.signature_verified) {
      await tx.query(
        `update webhook_events set status = 'rejected', processed_at = now() where id = $1`,
        [webhookEventId],
      );
      return;
    }

    await tx.query(
      `update webhook_events set status = 'processing', attempts = attempts + 1 where id = $1`,
      [webhookEventId],
    );

    try {
      const provider = getSignatureProvider(stored.provider);
      const events = provider.parseWebhook(stored.payload);

      if (events.length === 0) {
        await tx.query(
          `update webhook_events set status = 'ignored', processed_at = now() where id = $1`,
          [webhookEventId],
        );
        return;
      }

      for (const event of events) {
        await applySignatureEvent(tx, webhookEventId, stored.provider, event);
      }

      await tx.query(
        `update webhook_events set status = 'processed', processed_at = now(), last_error = null
         where id = $1`,
        [webhookEventId],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = stored.attempts + 1 >= stored.max_attempts;

      logger.error('Webhook processing failed', {
        webhook_event_id: webhookEventId,
        attempts: stored.attempts + 1,
        exhausted,
        error,
      });

      await tx.query(
        `update webhook_events
         set status = $2, last_error = $3,
             next_attempt_at = now() + make_interval(secs => $4)
         where id = $1`,
        [webhookEventId, exhausted ? 'failed' : 'failed', message.slice(0, 2000), backoffSeconds(stored.attempts + 1)],
      );

      if (exhausted) {
        await writeAudit(tx, {
          orgId: null,
          action: 'webhook.processing_exhausted',
          category: 'security',
          severity: 'critical',
          actorType: 'system',
          entityType: 'webhook_event',
          summary: `A ${stored.provider} webhook failed after ${stored.max_attempts} attempts and needs manual review`,
          metadata: { webhook_event_id: webhookEventId, error: message },
        });
      }
    }
  });
}

/**
 * Applies one normalised signature event to the contract it concerns.
 *
 * Everything here runs as service_role because a webhook arrives with no user
 * session: the tenant is discovered from the signature request, which is why
 * the org is set on the transaction before any write.
 */
async function applySignatureEvent(
  tx: Tx,
  webhookEventId: string,
  providerName: string,
  event: SignatureEvent,
): Promise<void> {
  const request = await tx.maybeOne<{
    id: string; org_id: string; contract_id: string; status: string; provider: string;
  }>(
    `select id, org_id, contract_id, status, provider
     from signature_requests
     where provider = $1 and provider_request_id = $2`,
    [providerName, event.providerRequestId],
  );

  if (!request) {
    logger.warn('Signature webhook for an unknown request', {
      provider: providerName,
      provider_request_id: event.providerRequestId,
    });
    return;
  }

  // Bind the webhook to its tenant now that we know it. This sets the database
  // GUC and the transaction context together, so anything emitted below knows
  // which organisation it belongs to.
  await tx.bindOrg(request.org_id);
  await tx.query(`update webhook_events set org_id = $2 where id = $1`, [
    webhookEventId,
    request.org_id,
  ]);

  // Idempotency at the domain layer as well: a replayed event that slipped past
  // the storage check still cannot be applied twice.
  const alreadyApplied = await tx.maybeOne<{ id: string }>(
    `select id from signature_events
     where signature_request_id = $1 and event_type = $2
       and coalesce(signer_email, '') = coalesce($3, '')
       and occurred_at = $4`,
    [request.id, event.type, event.signerEmail?.toLowerCase() ?? null, event.occurredAt],
  );
  if (alreadyApplied) return;

  await tx.query(
    `insert into signature_events (
       org_id, signature_request_id, webhook_event_id, event_type,
       signer_email, provider_signer_id, occurred_at, payload
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      request.org_id, request.id, webhookEventId, event.type,
      event.signerEmail?.toLowerCase() ?? null, event.providerSignerId ?? null,
      event.occurredAt, JSON.stringify(event.raw ?? {}),
    ],
  );

  const contract = await tx.one<{
    id: string; reference: string; status: string; company_id: string;
    contract_type: string; owner_user_id: string | null;
  }>(
    `select id, reference, status, company_id, contract_type, owner_user_id
     from contracts where id = $1 for update`,
    [request.contract_id],
  );

  // A terminal contract absorbs late events without changing.
  if (contract.status === 'fully_executed' || contract.status === 'voided') {
    logger.info('Signature event for a terminal contract, recorded but not applied', {
      contract_id: contract.id,
      status: contract.status,
      event_type: event.type,
    });
    return;
  }

  switch (event.type) {
    case 'viewed':
      await markSignerStatus(tx, request.contract_id, event.signerEmail, 'viewed');
      await advanceContract(tx, contract, 'viewed', request.id);
      await tx.query(
        `update contracts set first_viewed_at = coalesce(first_viewed_at, $2) where id = $1`,
        [contract.id, event.occurredAt],
      );
      break;

    case 'signed': {
      await markSignerStatus(tx, request.contract_id, event.signerEmail, 'signed', event.occurredAt);
      const remaining = await tx.one<{ count: string }>(
        `select count(*)::text as count from contract_signers
         where contract_id = $1 and status <> 'signed'`,
        [request.contract_id],
      );
      if (Number.parseInt(remaining.count, 10) > 0) {
        await advanceContract(tx, contract, 'partially_signed', request.id);
      }
      break;
    }

    case 'completed':
      await tx.query(
        `update signature_requests set status = 'completed', completed_at = $2 where id = $1`,
        [request.id, event.occurredAt],
      );
      await tx.query(
        `update contract_signers set status = 'signed', signed_at = coalesce(signed_at, $2)
         where contract_id = $1 and status <> 'declined'`,
        [request.contract_id, event.occurredAt],
      );
      // Execution is NOT applied here. The executed document must first be
      // downloaded, hashed and stored immutably; that work is queued and the
      // contract is marked executed only when it succeeds.
      await tx.query(
        `insert into jobs (org_id, queue, job_type, payload, priority, singleton_key)
         values ($1, 'default', 'signature.download_executed', $2, 10, $3)
         on conflict (singleton_key) where singleton_key is not null and status in ('queued','running')
         do nothing`,
        [
          request.org_id,
          JSON.stringify({ signatureRequestId: request.id, contractId: contract.id }),
          `download-executed:${request.id}`,
        ],
      );
      break;

    case 'declined':
      await markSignerStatus(tx, request.contract_id, event.signerEmail, 'declined', event.occurredAt);
      await tx.query(`update signature_requests set status = 'declined' where id = $1`, [request.id]);
      await tx.query(
        `update contracts set declined_at = $2, decline_reason = $3 where id = $1`,
        [contract.id, event.occurredAt, 'Declined by a signer via the signature provider'],
      );
      await advanceContract(tx, contract, 'declined', request.id);

      if (contract.owner_user_id) {
        await notify(tx, {
          userId: contract.owner_user_id,
          category: 'contract',
          title: 'Contract declined',
          body: `${contract.reference} was declined by ${event.signerEmail ?? 'a signer'}`,
          entityType: 'contract',
          entityId: contract.id,
          linkUrl: `/legal/contracts/${contract.id}`,
          priority: 'urgent',
          dedupeKey: `contract-declined:${contract.id}`,
        });
      }
      break;

    case 'expired':
      await tx.query(`update signature_requests set status = 'expired' where id = $1`, [request.id]);
      await advanceContract(tx, contract, 'expired', request.id);
      break;

    case 'voided':
      await tx.query(`update signature_requests set status = 'voided' where id = $1`, [request.id]);
      await tx.query(
        `update contracts set voided_at = $2, void_reason = $3 where id = $1`,
        [contract.id, event.occurredAt, 'Voided at the signature provider'],
      );
      await advanceContract(tx, contract, 'voided', request.id);
      break;

    case 'sent':
      await tx.query(`update signature_requests set status = 'sent' where id = $1`, [request.id]);
      break;

    case 'failed':
      await tx.query(
        `update signature_requests set status = 'failed', last_error = $2 where id = $1`,
        [request.id, 'The signature provider reported a failure'],
      );
      break;
  }

  await emitEvent(
    tx,
    {
      name: `contract.${event.type === 'signed' ? 'partially_signed' : event.type}`,
      entityType: 'contract',
      entityId: contract.id,
      payload: {
        reference: contract.reference,
        provider: providerName,
        signer_email: event.signerEmail ?? null,
        occurred_at: event.occurredAt,
      },
      actorType: 'provider',
      actorUserId: null,
    },
    { skipDispatch: event.type === 'sent' },
  );

  await recordActivity(tx, {
    entityType: 'contract',
    entityId: contract.id,
    companyId: contract.company_id,
    activityType: 'contract',
    title: describeEvent(event, contract.reference),
    actorType: 'provider',
    actorUserId: null,
    occurredAt: event.occurredAt,
  });
}

async function markSignerStatus(
  tx: Tx,
  contractId: string,
  email: string | undefined,
  status: string,
  at?: string,
): Promise<void> {
  if (!email) return;
  await tx.query(
    `update contract_signers
     set status = $3, signed_at = case when $3 = 'signed' then coalesce($4::timestamptz, now()) else signed_at end,
         declined_at = case when $3 = 'declined' then coalesce($4::timestamptz, now()) else declined_at end
     where contract_id = $1 and lower(email) = $2`,
    [contractId, email.toLowerCase(), status, at ?? null],
  );
}

/**
 * Moves the contract, tolerating an edge the machine does not define.
 *
 * Providers deliver events out of order and sometimes deliver an event for a
 * state we have already passed. That is not an error worth failing a webhook
 * over, so an invalid edge is logged and skipped rather than thrown.
 */
async function advanceContract(
  tx: Tx,
  contract: { id: string; status: string },
  to: string,
  signatureRequestId: string,
): Promise<void> {
  const { performTransition } = await import('@/lib/workflows/state-machine');
  const { contractMachine } = await import('@/lib/workflows/machines');

  try {
    await performTransition(
      tx,
      contractMachine,
      contract.id,
      { to, reason: 'Reported by the signature provider', payload: { signature_request_id: signatureRequestId } },
      // Not a person: the signature provider moved this contract.
      { userId: null, actorType: 'provider' },
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_TRANSITION') {
      logger.info('Out-of-order signature event skipped', {
        contract_id: contract.id,
        from: contract.status,
        to,
      });
      return;
    }
    throw error;
  }
}

function describeEvent(event: SignatureEvent, reference: string): string {
  const who = event.signerEmail ? ` by ${event.signerEmail}` : '';
  switch (event.type) {
    case 'viewed': return `${reference} viewed${who}`;
    case 'signed': return `${reference} signed${who}`;
    case 'completed': return `${reference} fully signed by all parties`;
    case 'declined': return `${reference} declined${who}`;
    case 'expired': return `${reference} expired before it was signed`;
    case 'voided': return `${reference} voided at the provider`;
    case 'sent': return `${reference} delivered to signers`;
    default: return `${reference}: signature provider reported ${event.type}`;
  }
}
