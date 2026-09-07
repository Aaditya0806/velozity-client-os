/**
 * WhatsApp, via the Meta Cloud API.
 *
 * Two things about WhatsApp differ from every other channel here and both are
 * enforced rather than documented:
 *
 *   1. Outside a 24-hour window opened by the recipient, only an approved
 *      template may be sent. Free text is silently useless — the API accepts it
 *      and the person never sees it. So a connection must name a template, and
 *      free-text sending is refused rather than attempted.
 *
 *   2. Numbers must be E.164. A number in some other format is rejected by the
 *      API in a way that reads like an auth failure.
 */
import 'server-only';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';
import type { ChannelProvider, ChannelMessage, ChannelCredentials, ChannelSendResult } from './types';

const E164 = /^\+[1-9]\d{7,14}$/;

interface WhatsAppResponse {
  messages?: Array<{ id: string }>;
  error?: { message?: string; code?: number; type?: string };
}

export const whatsappProvider: ChannelProvider = {
  name: 'whatsapp',

  async send(message: ChannelMessage, credentials: ChannelCredentials): Promise<ChannelSendResult> {
    const phoneNumberId = credentials.config.phone_number_id;
    const template = credentials.config.template_name;
    const language = (credentials.config.template_language as string) ?? 'en_US';

    if (!credentials.token || typeof phoneNumberId !== 'string') {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'This WhatsApp connection needs an access token and a phone_number_id.',
      );
    }

    if (typeof template !== 'string' || template.length === 0) {
      // Refused rather than attempted: a free-text message outside the 24-hour
      // window is accepted by the API and never delivered, which is the worst
      // possible failure mode — it looks like success.
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'This WhatsApp connection has no approved template. Business-initiated messages must use one, so nothing was sent.',
      );
    }

    if (!E164.test(message.recipient)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `"${message.recipient}" is not an E.164 phone number (it must start with + and a country code).`,
      );
    }

    const text = message.url ? `${message.body} ${message.url}` : message.body;

    let response: Response;
    try {
      response = await fetch(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credentials.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: message.recipient,
            type: 'template',
            template: {
              name: template,
              language: { code: language },
              components: [
                {
                  type: 'body',
                  // One body parameter, carrying the alert text. A template with
                  // a different shape will be rejected by Meta, which is the
                  // correct outcome: the template is the contract.
                  parameters: [{ type: 'text', text }],
                },
              ],
            },
          }),
        },
      );
    } catch (error) {
      throw new AppError('PROVIDER_ERROR', 'Could not reach WhatsApp.', { cause: error });
    }

    const body = (await response.json().catch(() => ({}))) as WhatsAppResponse;

    if (!response.ok) {
      logger.error('WhatsApp rejected a message', {
        status: response.status,
        error: body.error?.message,
        code: body.error?.code,
      });

      if (response.status === 401 || response.status === 403) {
        throw new AppError(
          'PROVIDER_UNAVAILABLE',
          'The WhatsApp access token was rejected. Tokens from the Meta test console expire after 24 hours.',
        );
      }
      throw new AppError(
        'PROVIDER_ERROR',
        `WhatsApp returned an error (${body.error?.message ?? response.status}).`,
      );
    }

    const id = body.messages?.[0]?.id;
    if (!id) {
      throw new AppError('PROVIDER_ERROR', 'WhatsApp accepted the message but returned no id.');
    }

    return { providerMessageId: id, delivered: true };
  },
};
