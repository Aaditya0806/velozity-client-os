/**
 * Manual signature provider.
 *
 * Records the request and lets an authorised operator mark signatures by hand.
 * Its purpose is not to be a toy: it means the entire legal workflow - approval,
 * send, signature events, executed-document storage, hash verification and the
 * onboarding gate - is exercisable end to end without a provider account, in
 * development, in CI and in a customer trial.
 *
 * It is also the fallback when a provider is unavailable and a deal genuinely
 * cannot wait.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type {
  SignatureProvider, PreparedDocument, Signer, SignatureOptions,
  ProviderRequest, SignatureStatus, WebhookVerification, SignatureEvent,
} from './types';
import { serverEnv } from '@/lib/config/env';
import { AppError } from '@/lib/http/errors';

/**
 * In-memory record of what was requested, so getStatus() can answer.
 * Authoritative state lives in `signature_requests` and `signature_events`;
 * this is only a convenience for the adapter itself.
 */
const requests = new Map<string, { signers: Signer[]; document: PreparedDocument }>();

export const manualSignatureProvider: SignatureProvider = {
  name: 'manual',

  async createRequest(
    doc: PreparedDocument,
    signers: Signer[],
    _opts: SignatureOptions,
  ): Promise<ProviderRequest> {
    const providerRequestId = `manual_${randomUUID()}`;
    requests.set(providerRequestId, { signers, document: doc });

    return {
      providerRequestId,
      status: 'sent',
      signerIds: Object.fromEntries(
        signers.map((s) => [s.email.toLowerCase(), `manual_signer_${s.order}`]),
      ),
    };
  },

  async getStatus(providerRequestId: string): Promise<SignatureStatus> {
    const record = requests.get(providerRequestId);
    return {
      status: 'sent',
      signers: (record?.signers ?? []).map((s) => ({ email: s.email, status: 'sent' as const })),
    };
  },

  /**
   * Returns the exact bytes that were sent.
   *
   * A real provider stamps signature blocks onto the PDF, so the executed file
   * differs from the one sent. Here they are identical, which the workflow
   * handles correctly: it hashes whatever it receives and stores that hash,
   * rather than assuming any relationship to the sent hash.
   */
  async downloadExecuted(providerRequestId: string): Promise<Buffer> {
    const record = requests.get(providerRequestId);
    if (!record) {
      throw new AppError(
        'PROVIDER_ERROR',
        'This manual signature request is not known to this process. Upload the executed document directly.',
      );
    }
    return record.document.content;
  },

  /**
   * Manual "webhooks" are internal calls made by an operator action. They are
   * still signed with APP_SECRET so the endpoint cannot be driven from outside.
   */
  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookVerification {
    const provided = headers.get('x-velozity-signature');
    if (!provided) return { valid: false, reason: 'No signature header was present.' };

    const expected = createHmac('sha256', serverEnv().APP_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(provided.replace(/^sha256=/i, '').toLowerCase(), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return { valid: false, reason: 'Signature length mismatch.' };
    if (!timingSafeEqual(a, b)) return { valid: false, reason: 'Signature did not match.' };
    return { valid: true };
  },

  parseWebhook(payload: unknown): SignatureEvent[] {
    const body = payload as {
      event_id?: string;
      request_id?: string;
      type?: SignatureEvent['type'];
      signer_email?: string;
      occurred_at?: string;
    };
    if (!body.request_id || !body.type) return [];

    return [
      {
        providerEventId: body.event_id ?? `${body.request_id}:${body.type}:${body.signer_email ?? ''}`,
        providerRequestId: body.request_id,
        type: body.type,
        signerEmail: body.signer_email,
        occurredAt: body.occurred_at ?? new Date().toISOString(),
        raw: payload,
      },
    ];
  },

  async void(providerRequestId: string): Promise<void> {
    requests.delete(providerRequestId);
  },
};

/** Signs a manual webhook body the way the endpoint expects. */
export function signManualWebhook(body: string): string {
  return createHmac('sha256', serverEnv().APP_SECRET).update(body).digest('hex');
}
