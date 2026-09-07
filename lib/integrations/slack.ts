/**
 * Slack, via chat.postMessage.
 *
 * A bot token and a channel id. No socket mode, no interactivity, no slash
 * commands: this posts a message and nothing else, which is all the product
 * needs and the smallest surface to secure.
 */
import 'server-only';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';
import type { ChannelProvider, ChannelMessage, ChannelCredentials, ChannelSendResult } from './types';

interface SlackResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** Slack errors that will never succeed on retry. */
const PERMANENT = new Set([
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'not_authed',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'restricted_action',
]);

export const slackProvider: ChannelProvider = {
  name: 'slack',

  async send(message: ChannelMessage, credentials: ChannelCredentials): Promise<ChannelSendResult> {
    if (!credentials.token) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'This Slack connection has no bot token.');
    }

    const text = message.url ? `${message.body}\n${message.url}` : message.body;

    let response: Response;
    try {
      response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: message.recipient,
          text,
          // Suppresses Slack's own preview card, which turns a one-line alert
          // into a screenful.
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
    } catch (error) {
      throw new AppError('PROVIDER_ERROR', 'Could not reach Slack.', { cause: error });
    }

    // Slack answers 200 with ok:false for application errors, so the status
    // alone says almost nothing.
    const body = (await response.json().catch(() => ({ ok: false }))) as SlackResponse;

    if (!body.ok) {
      logger.error('Slack rejected a message', { error: body.error, channel: message.recipient });

      if (body.error && PERMANENT.has(body.error)) {
        throw new AppError(
          'PROVIDER_UNAVAILABLE',
          `Slack refused the message (${body.error}). Check the bot token, and that the bot has been invited to the channel.`,
        );
      }
      throw new AppError('PROVIDER_ERROR', `Slack returned an error (${body.error ?? 'unknown'}).`);
    }

    if (!body.ts) {
      throw new AppError('PROVIDER_ERROR', 'Slack accepted the message but returned no id.');
    }

    return { providerMessageId: body.ts, delivered: true };
  },
};
