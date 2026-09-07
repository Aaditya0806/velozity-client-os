/**
 * The email provider contract.
 *
 * Phase 1 is outbound only. There is deliberately no mailbox sync here: reading
 * a customer's inbox is a much larger commitment, both technically and in terms
 * of what the product is trusted with, and it belongs in its own phase.
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface OutboundEmail {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  html: string;
  text?: string;
  /** Correlates the provider's events back to our message row. */
  referenceId?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  accepted: boolean;
  raw?: unknown;
}

export type EmailEventType =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'complained'
  | 'delivery_delayed'
  | 'failed';

export interface EmailEvent {
  providerEventId: string;
  providerMessageId: string;
  type: EmailEventType;
  recipient?: string;
  url?: string;
  userAgent?: string;
  occurredAt: string;
  raw: unknown;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
}

export interface EmailProvider {
  readonly name: 'resend' | 'ses' | 'noop';
  send(email: OutboundEmail): Promise<SendResult>;
  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookVerification;
  parseWebhook(payload: unknown): EmailEvent[];
}
