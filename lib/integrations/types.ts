/**
 * Outbound channel providers.
 *
 * A channel sends a short message somewhere a person will see it. That is the
 * whole contract, and it is deliberately narrow: this is not a messaging
 * platform, it is a way to get an alert out of the product.
 *
 * Nothing here sends email. Email has its own pipeline with approval, recording
 * and suppression, and routing it through a "channel" would quietly bypass all
 * three.
 */

export type ChannelProviderName = 'slack' | 'whatsapp';

export interface ChannelMessage {
  /** Where it goes: a Slack channel id, or an E.164 phone number. */
  recipient: string;
  /** Plain text. Providers that support formatting receive it as-is. */
  body: string;
  /** Used where the provider has a concept of one; ignored otherwise. */
  subject?: string;
  /** A link the message should carry, appended when the provider has no rich form. */
  url?: string;
}

export interface ChannelSendResult {
  providerMessageId: string;
  delivered: boolean;
}

export interface ChannelCredentials {
  /** Resolved from the secret store by the caller, never read from the database. */
  token: string;
  /** Provider-specific non-secret settings from `integration_connections.config`. */
  config: Record<string, unknown>;
}

export interface ChannelProvider {
  readonly name: ChannelProviderName;
  /**
   * Sends one message.
   *
   * Throws an AppError on failure. A provider distinguishes a configuration
   * fault (`PROVIDER_UNAVAILABLE`, do not retry) from a transient one
   * (`PROVIDER_ERROR`, retry), because the job queue treats them differently
   * and retrying a bad token forever hides the message that explains it.
   */
  send(message: ChannelMessage, credentials: ChannelCredentials): Promise<ChannelSendResult>;
}
