/**
 * Microsoft 365, via Graph.
 *
 * Reads only, with `Mail.Read`. Graph returns bodies and headers in one call,
 * so unlike Gmail this needs no second request per message — the shape of the
 * two adapters differs because the APIs differ, not because one is a copy of
 * the other with names changed.
 */
import 'server-only';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';
import type {
  MailboxProvider, MailboxCredentials, MailboxPage, InboundMessage,
} from './types';

interface GraphAddress {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: GraphAddress;
  sender?: GraphAddress;
  toRecipients?: GraphAddress[];
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

interface GraphListResponse {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

const SELECT = [
  'id', 'internetMessageId', 'conversationId', 'subject', 'bodyPreview',
  'receivedDateTime', 'from', 'toRecipients', 'body', 'internetMessageHeaders',
].join(',');

export const microsoftProvider: MailboxProvider = {
  name: 'microsoft',

  async list(
    credentials: MailboxCredentials,
    cursor: string | null,
    limit: number,
  ): Promise<MailboxPage> {
    if (!credentials.accessToken) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'This Microsoft connection has no access token.');
    }

    // The cursor is Graph's own delta link once one exists, so a resumed sync
    // asks the server what changed rather than re-reading a date window.
    const url =
      cursor ??
      `https://graph.microsoft.com/v1.0/me/messages/delta?$select=${SELECT}&$top=${Math.min(limit, 100)}`;

    const listed = await call<GraphListResponse>(url, credentials.accessToken);

    const messages: InboundMessage[] = [];
    for (const message of listed.value ?? []) {
      const address = message.from?.emailAddress ?? message.sender?.emailAddress;
      const fromEmail = address?.address?.trim().toLowerCase();
      if (!fromEmail || !message.internetMessageId) continue;

      const inReplyTo =
        message.internetMessageHeaders?.find(
          (header) => header.name.toLowerCase() === 'in-reply-to',
        )?.value ?? null;

      const raw = message.body?.content ?? '';
      const text =
        message.body?.contentType?.toLowerCase() === 'html'
          ? raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          : raw;

      messages.push({
        rfc822MessageId: message.internetMessageId,
        threadKey: message.conversationId ?? null,
        inReplyTo,
        fromEmail,
        fromName: address?.name ?? null,
        toEmails: (message.toRecipients ?? [])
          .map((r) => r.emailAddress?.address?.trim().toLowerCase())
          .filter((value): value is string => Boolean(value)),
        subject: message.subject ?? '(no subject)',
        bodyText: text.slice(0, 50_000),
        snippet: (message.bodyPreview ?? text).slice(0, 300),
        receivedAt: message.receivedDateTime ?? new Date().toISOString(),
      });
    }

    // A delta link means "caught up, resume here next time"; a next link means
    // there are more pages now. Both are stored the same way.
    return {
      messages,
      cursor: listed['@odata.nextLink'] ?? listed['@odata.deltaLink'] ?? null,
    };
  },
};

async function call<T>(url: string, accessToken: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        // Asks Graph for plain text where the message has it, which avoids
        // stripping HTML for most messages.
        prefer: 'outlook.body-content-type="text"',
      },
    });
  } catch (error) {
    throw new AppError('PROVIDER_ERROR', 'Could not reach Microsoft Graph.', { cause: error });
  }

  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'Microsoft rejected the access token. The mailbox connection needs to be reauthorised.',
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error('Graph request failed', { status: response.status, detail: detail.slice(0, 300) });
    throw new AppError('PROVIDER_ERROR', `Microsoft Graph returned HTTP ${response.status}.`);
  }

  return (await response.json()) as T;
}
