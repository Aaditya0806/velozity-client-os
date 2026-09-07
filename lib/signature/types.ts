/**
 * The e-signature provider contract.
 *
 * Everything the application knows about signing is expressed here. Adding a
 * provider means implementing this interface; no domain code changes.
 *
 * Two properties matter most:
 *   - `verifyWebhook` is separate from `parseWebhook`, so a payload cannot be
 *     interpreted before its signature has been checked;
 *   - `downloadExecuted` returns bytes, which the application hashes itself.
 *     We never take a provider's word for what a document contains.
 */

export interface PreparedDocument {
  /** Human-readable name shown to signers. */
  name: string;
  mimeType: string;
  content: Buffer;
  /** SHA-256 of `content`, computed before the document leaves us. */
  sha256: string;
}

export interface Signer {
  name: string;
  email: string;
  /** 1-based. Signers with the same order sign in parallel. */
  order: number;
  role?: string;
  party: 'internal' | 'counterparty' | 'witness';
}

export interface SignatureOptions {
  subject: string;
  message?: string;
  expiresInDays?: number;
  /** Correlation id echoed back on webhooks where the provider supports it. */
  referenceId?: string;
  /** Where the provider should send the signer after completion. */
  redirectUrl?: string;
}

export interface ProviderRequest {
  providerRequestId: string;
  status: SignatureStatus['status'];
  /** Provider-side signer identifiers, keyed by email. */
  signerIds?: Record<string, string>;
  raw?: unknown;
}

export interface SignatureStatus {
  status:
    | 'created'
    | 'sent'
    | 'viewed'
    | 'partially_signed'
    | 'completed'
    | 'declined'
    | 'expired'
    | 'voided'
    | 'failed';
  signers: Array<{
    email: string;
    status: 'pending' | 'sent' | 'viewed' | 'signed' | 'declined' | 'bounced';
    signedAt?: string;
    declineReason?: string;
  }>;
  completedAt?: string;
  raw?: unknown;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
}

export interface SignatureEvent {
  /** Provider's own event id. The idempotency key for webhook processing. */
  providerEventId: string;
  providerRequestId: string;
  type:
    | 'sent'
    | 'viewed'
    | 'signed'
    | 'declined'
    | 'completed'
    | 'expired'
    | 'voided'
    | 'failed';
  signerEmail?: string;
  providerSignerId?: string;
  occurredAt: string;
  raw: unknown;
}

export interface SignatureProvider {
  readonly name: 'zoho_sign' | 'docusign' | 'adobe_sign' | 'manual';

  createRequest(
    doc: PreparedDocument,
    signers: Signer[],
    opts: SignatureOptions,
  ): Promise<ProviderRequest>;

  getStatus(providerRequestId: string): Promise<SignatureStatus>;

  downloadExecuted(providerRequestId: string): Promise<Buffer>;

  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookVerification;

  parseWebhook(payload: unknown): SignatureEvent[];

  void(providerRequestId: string, reason: string): Promise<void>;
}
