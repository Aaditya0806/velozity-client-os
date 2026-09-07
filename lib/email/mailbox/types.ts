/**
 * Reading a mailbox.
 *
 * The contract is deliberately one-way: list what has arrived since a cursor,
 * and fetch one message. There is no `send` here, and that is not an oversight.
 * Outbound mail goes through the existing pipeline, where it is recorded,
 * approved where required, suppressed against bounces and rate limited. A
 * second sending path that skipped all of that would defeat every one of them.
 */

export type MailboxProviderName = 'gmail' | 'microsoft';

export interface InboundMessage {
  /** RFC 5322 Message-ID. The identity used to dedupe. */
  rfc822MessageId: string;
  /** The provider's conversation id, where it has one. */
  threadKey: string | null;
  inReplyTo: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  subject: string;
  bodyText: string;
  snippet: string;
  receivedAt: string;
}

export interface MailboxPage {
  messages: InboundMessage[];
  /** Opaque; passed back on the next sync. Null when fully caught up. */
  cursor: string | null;
}

export interface MailboxCredentials {
  /** A short-lived access token, refreshed by the caller. */
  accessToken: string;
  config: Record<string, unknown>;
}

export interface MailboxProvider {
  readonly name: MailboxProviderName;
  /**
   * Messages received since `cursor`.
   *
   * Implementations overlap deliberately rather than resuming exactly: a cursor
   * that never re-reads loses messages that arrived during the previous page.
   * Duplicates are cheap — `app.ingest_inbound_email` discards them — and a
   * lost client email is not.
   */
  list(credentials: MailboxCredentials, cursor: string | null, limit: number): Promise<MailboxPage>;
}
