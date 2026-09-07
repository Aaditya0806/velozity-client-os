/**
 * Gmail, via the Gmail API.
 *
 * Reads only. The scope this needs is `gmail.readonly`; nothing here requires
 * send, modify or delete, and asking for less is the difference between an
 * integration a customer's IT will approve and one they will not.
 */
import 'server-only';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';
import type {
  MailboxProvider, MailboxCredentials, MailboxPage, InboundMessage,
} from './types';

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  historyId?: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function header(message: GmailMessage, name: string): string | null {
  const found = message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? null;
}

/** Gmail encodes bodies as base64url, and nests them arbitrarily deep. */
function extractText(part: GmailPart | undefined): string {
  if (!part) return '';

  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }

  for (const child of part.parts ?? []) {
    const text = extractText(child);
    if (text) return text;
  }

  // Falling back to the HTML part only when there is no plain-text alternative.
  // It is stored as text and never rendered as HTML.
  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url')
      .toString('utf8')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return '';
}

/** `Name <addr@example.com>` or a bare address. */
function parseAddress(raw: string | null): { email: string; name: string | null } {
  if (!raw) return { email: '', name: null };
  const match = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (match) return { email: (match[2] ?? '').trim().toLowerCase(), name: match[1]?.trim() || null };
  return { email: raw.trim().toLowerCase(), name: null };
}

function parseAddressList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => parseAddress(part).email)
    .filter((email) => email.length > 0);
}

export const gmailProvider: MailboxProvider = {
  name: 'gmail',

  async list(
    credentials: MailboxCredentials,
    cursor: string | null,
    limit: number,
  ): Promise<MailboxPage> {
    if (!credentials.accessToken) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'This Gmail connection has no access token.');
    }

    const params = new URLSearchParams({
      maxResults: String(Math.min(limit, 100)),
      // Inbox and sent both: a thread with a client is only legible if it has
      // both halves of the conversation in it.
      q: 'in:anywhere -in:spam -in:trash',
    });
    if (cursor) params.set('pageToken', cursor);

    const listed = await call<GmailListResponse>(
      `${BASE}/messages?${params}`,
      credentials.accessToken,
    );

    const messages: InboundMessage[] = [];
    for (const stub of listed.messages ?? []) {
      const full = await call<GmailMessage>(
        `${BASE}/messages/${stub.id}?format=full`,
        credentials.accessToken,
      );

      const from = parseAddress(header(full, 'From'));
      if (!from.email) continue;

      const messageId = header(full, 'Message-ID');
      if (!messageId) continue;

      const body = extractText(full.payload);

      messages.push({
        rfc822MessageId: messageId,
        threadKey: full.threadId ?? null,
        inReplyTo: header(full, 'In-Reply-To'),
        fromEmail: from.email,
        fromName: from.name,
        toEmails: parseAddressList(header(full, 'To')),
        subject: header(full, 'Subject') ?? '(no subject)',
        bodyText: body.slice(0, 50_000),
        snippet: (full.snippet ?? body).slice(0, 300),
        receivedAt: full.internalDate
          ? new Date(Number(full.internalDate)).toISOString()
          : new Date().toISOString(),
      });
    }

    return { messages, cursor: listed.nextPageToken ?? null };
  },
};

async function call<T>(url: string, accessToken: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    throw new AppError('PROVIDER_ERROR', 'Could not reach Gmail.', { cause: error });
  }

  if (response.status === 401 || response.status === 403) {
    // The refresh token has been revoked, or the user changed their password.
    // Retrying cannot fix it; the connection needs reauthorising.
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'Gmail rejected the access token. The mailbox connection needs to be reauthorised.',
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error('Gmail request failed', { status: response.status, detail: detail.slice(0, 300) });
    throw new AppError('PROVIDER_ERROR', `Gmail returned HTTP ${response.status}.`);
  }

  return (await response.json()) as T;
}
