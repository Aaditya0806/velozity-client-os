/**
 * Email provider implementations.
 *
 * A note on open tracking: opens are recorded because the data model has a place
 * for them, and they are useful as a weak signal. Nothing in this product gates
 * on them. Image proxies pre-fetch tracking pixels, privacy settings suppress
 * them entirely, and a message that shows no open has very often been read.
 */
import 'server-only';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type {
  EmailProvider, OutboundEmail, SendResult, EmailEvent, WebhookVerification,
} from './types';
import { serverEnv } from '@/lib/config/env';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

function formatAddress(address: { email: string; name?: string }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

// -----------------------------------------------------------------------------
// Resend
// -----------------------------------------------------------------------------
export const resendProvider: EmailProvider = {
  name: 'resend',

  async send(email: OutboundEmail): Promise<SendResult> {
    const env = serverEnv();
    if (!env.RESEND_API_KEY) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'Resend is not configured.');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: formatAddress(email.from),
        to: email.to.map(formatAddress),
        ...(email.cc?.length ? { cc: email.cc.map(formatAddress) } : {}),
        ...(email.bcc?.length ? { bcc: email.bcc.map(formatAddress) } : {}),
        ...(email.replyTo ? { reply_to: formatAddress(email.replyTo) } : {}),
        subject: email.subject,
        html: email.html,
        ...(email.text ? { text: email.text } : {}),
        ...(email.referenceId ? { tags: [{ name: 'reference', value: email.referenceId }] } : {}),
        ...(email.headers ? { headers: email.headers } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error('Resend rejected a message', { status: response.status, body: body.slice(0, 500) });
      throw new AppError('PROVIDER_ERROR', 'The email provider rejected the message.', {
        details: { status: response.status },
      });
    }

    const data = (await response.json()) as { id?: string };
    if (!data.id) throw new AppError('PROVIDER_ERROR', 'Resend returned no message id.');

    return { providerMessageId: data.id, accepted: true, raw: data };
  },

  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookVerification {
    const secret = serverEnv().RESEND_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'RESEND_WEBHOOK_SECRET is not configured.' };

    // Svix-style signature: v1,<base64>. The signed payload is id.timestamp.body.
    const id = headers.get('svix-id');
    const timestamp = headers.get('svix-timestamp');
    const signatures = headers.get('svix-signature');

    if (!id || !timestamp || !signatures) {
      return { valid: false, reason: 'Signature headers were missing.' };
    }

    // Reject a replay of an old, correctly-signed delivery.
    const age = Math.abs(Date.now() / 1000 - Number.parseInt(timestamp, 10));
    if (!Number.isFinite(age) || age > 300) {
      return { valid: false, reason: 'The signature timestamp is outside the accepted window.' };
    }

    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${rawBody.toString('utf8')}`)
      .digest('base64');

    const provided = signatures
      .split(' ')
      .map((part) => part.split(',')[1])
      .filter((value): value is string => Boolean(value));

    const matched = provided.some((candidate) => {
      const a = Buffer.from(candidate, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    });

    return matched ? { valid: true } : { valid: false, reason: 'No signature matched.' };
  },

  parseWebhook(payload: unknown): EmailEvent[] {
    const body = payload as {
      type?: string;
      created_at?: string;
      data?: { email_id?: string; to?: string[]; click?: { link?: string }; user_agent?: string };
    };

    const map: Record<string, EmailEvent['type']> = {
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.delivery_delayed': 'delivery_delayed',
      'email.opened': 'opened',
      'email.clicked': 'clicked',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
    };

    const type = map[body.type ?? ''];
    if (!type || !body.data?.email_id) return [];

    return [
      {
        providerEventId: `${body.data.email_id}:${body.type}:${body.created_at ?? ''}`,
        providerMessageId: body.data.email_id,
        type,
        recipient: body.data.to?.[0],
        url: body.data.click?.link,
        userAgent: body.data.user_agent,
        occurredAt: body.created_at ?? new Date().toISOString(),
        raw: payload,
      },
    ];
  },
};

// -----------------------------------------------------------------------------
// AWS SES
// -----------------------------------------------------------------------------
export const sesProvider: EmailProvider = {
  name: 'ses',

  async send(): Promise<SendResult> {
    // Intentionally not implemented: shipping a hand-rolled SigV4 signer would
    // be a liability next to the AWS SDK. The interface is here so adding SES is
    // a matter of installing @aws-sdk/client-sesv2 and filling this in - no
    // caller changes.
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'The SES provider is not implemented. Install @aws-sdk/client-sesv2 and complete lib/email/providers.ts, or use Resend.',
    );
  },

  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookVerification {
    const secret = serverEnv().SES_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'SES_WEBHOOK_SECRET is not configured.' };

    const provided = headers.get('x-amz-sns-signature') ?? headers.get('x-velozity-signature');
    if (!provided) return { valid: false, reason: 'No signature header was present.' };

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(provided.toLowerCase(), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Signature did not match.' };
    }
    return { valid: true };
  },

  parseWebhook(payload: unknown): EmailEvent[] {
    const body = payload as {
      eventType?: string;
      mail?: { messageId?: string; destination?: string[]; timestamp?: string };
    };

    const map: Record<string, EmailEvent['type']> = {
      Send: 'sent',
      Delivery: 'delivered',
      Bounce: 'bounced',
      Complaint: 'complained',
      Open: 'opened',
      Click: 'clicked',
      DeliveryDelay: 'delivery_delayed',
    };

    const type = map[body.eventType ?? ''];
    if (!type || !body.mail?.messageId) return [];

    return [
      {
        providerEventId: `${body.mail.messageId}:${body.eventType}:${body.mail.timestamp ?? ''}`,
        providerMessageId: body.mail.messageId,
        type,
        recipient: body.mail.destination?.[0],
        occurredAt: body.mail.timestamp ?? new Date().toISOString(),
        raw: payload,
      },
    ];
  },
};

// -----------------------------------------------------------------------------
// No-op
// -----------------------------------------------------------------------------
/**
 * Records the message and logs it without sending.
 *
 * The default in development, so the whole compose-approve-send flow can be
 * exercised without anything reaching a real inbox. Sending a test email to a
 * real client is a mistake worth designing out.
 */
export const noopProvider: EmailProvider = {
  name: 'noop',

  async send(email: OutboundEmail): Promise<SendResult> {
    logger.info('Email not sent (noop provider)', {
      to: email.to.map((t) => t.email),
      subject: email.subject,
    });
    return { providerMessageId: `noop_${randomUUID()}`, accepted: true };
  },

  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookVerification {
    const provided = headers.get('x-velozity-signature');
    if (!provided) return { valid: false, reason: 'No signature header was present.' };
    const expected = createHmac('sha256', serverEnv().APP_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(provided.toLowerCase(), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Signature did not match.' };
    }
    return { valid: true };
  },

  parseWebhook(payload: unknown): EmailEvent[] {
    const body = payload as {
      message_id?: string;
      type?: EmailEvent['type'];
      occurred_at?: string;
    };
    if (!body.message_id || !body.type) return [];
    return [
      {
        providerEventId: `${body.message_id}:${body.type}`,
        providerMessageId: body.message_id,
        type: body.type,
        occurredAt: body.occurred_at ?? new Date().toISOString(),
        raw: payload,
      },
    ];
  },
};

const PROVIDERS: Record<string, EmailProvider> = {
  resend: resendProvider,
  ses: sesProvider,
  noop: noopProvider,
};

export function getEmailProvider(name?: string): EmailProvider {
  const key = name ?? serverEnv().EMAIL_PROVIDER;
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new AppError('PROVIDER_UNAVAILABLE', `No email provider is configured for "${key}".`);
  }
  return provider;
}

export function availableEmailProviders(): string[] {
  return Object.keys(PROVIDERS);
}
