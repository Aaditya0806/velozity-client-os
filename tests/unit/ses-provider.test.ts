/**
 * The SES adapter cannot be exercised against AWS from here — that needs an
 * account, a verified sender identity and a region. What can be verified is
 * everything this code is actually responsible for: the shape of the command it
 * builds, and how it classifies the failures SES returns. Both are places where
 * a mistake is silent until a real message is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    send = send;
  },
  // The real command simply carries its input; keeping that contract lets the
  // assertions below read the payload the adapter built.
  SendEmailCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const BASE = {
  from: { email: 'no-reply@velozity.test', name: 'Velozity' },
  to: [{ email: 'client@example.test', name: 'A Client' }],
  subject: 'Subject',
  html: '<p>Body</p>',
};

async function sendWith(overrides: Record<string, unknown> = {}) {
  const { sesProvider } = await import('@/lib/email/providers');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sesProvider.send({ ...BASE, ...overrides } as any);
  return send.mock.calls.at(-1)?.[0].input as Record<string, any>;
}

describe('the SES provider', () => {
  beforeEach(() => {
    vi.resetModules();
    send.mockReset();
    send.mockResolvedValue({ MessageId: 'ses-message-id' });
    process.env.AWS_SES_REGION = 'eu-west-1';
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    delete process.env.SES_CONFIGURATION_SET;
  });

  it('returns the provider message id', async () => {
    const { sesProvider } = await import('@/lib/email/providers');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await sesProvider.send(BASE as any);
    expect(result).toMatchObject({ providerMessageId: 'ses-message-id', accepted: true });
  });

  it('formats a named address the way SMTP expects', async () => {
    const input = await sendWith();
    expect(input.FromEmailAddress).toBe('Velozity <no-reply@velozity.test>');
    expect(input.Destination.ToAddresses).toEqual(['A Client <client@example.test>']);
  });

  it('omits cc and bcc entirely rather than sending empty lists', async () => {
    // SES v2 rejects an empty address array; Resend ignores one. Copying the
    // Resend shape across would fail only for messages that happen to have no
    // cc — which is most of them, and none of the ones anyone tests by hand.
    const input = await sendWith({ cc: [], bcc: [] });
    expect(input.Destination).not.toHaveProperty('CcAddresses');
    expect(input.Destination).not.toHaveProperty('BccAddresses');
  });

  it('includes a plain-text part only when one was given', async () => {
    const withText = await sendWith({ text: 'Body' });
    expect(withText.Content.Simple.Body.Text.Data).toBe('Body');

    const withoutText = await sendWith();
    expect(withoutText.Content.Simple.Body).not.toHaveProperty('Text');
  });

  it('tags the message with the reference id so webhooks can correlate it', async () => {
    const input = await sendWith({ referenceId: 'b3d3f0e2-0000-4000-8000-000000000000' });
    expect(input.EmailTags).toEqual([
      { Name: 'reference', Value: 'b3d3f0e2-0000-4000-8000-000000000000' },
    ]);
  });

  it('drops a reference id SES would reject rather than sending it', async () => {
    // SES tag values allow only letters, digits, underscore and hyphen. Sending
    // an invalid one fails the whole message; losing the correlation costs a
    // webhook lookup. The message matters more.
    const input = await sendWith({ referenceId: 'invoice/2026 #12' });
    expect(input).not.toHaveProperty('EmailTags');
  });

  it('names the configuration set when one is set, because events depend on it', async () => {
    process.env.SES_CONFIGURATION_SET = 'velozity-events';
    const input = await sendWith();
    expect(input.ConfigurationSetName).toBe('velozity-events');
  });

  it('refuses to send when no region is configured', async () => {
    delete process.env.AWS_SES_REGION;
    const { sesProvider } = await import('@/lib/email/providers');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(sesProvider.send(BASE as any)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('reports an unverified sender as a configuration fault, not a transient one', async () => {
    // The distinction decides whether the job queue retries. Retrying an
    // unverified identity forever buries the one message that explains it.
    const rejection = Object.assign(new Error('Email address is not verified.'), {
      name: 'MessageRejected',
    });
    send.mockRejectedValueOnce(rejection);

    const { sesProvider } = await import('@/lib/email/providers');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(sesProvider.send(BASE as any)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('reports an unexpected failure as a provider error', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'ThrottlingException' }));
    const { sesProvider } = await import('@/lib/email/providers');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(sesProvider.send(BASE as any)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('fails loudly if SES accepts the message but returns no id', async () => {
    send.mockResolvedValueOnce({});
    const { sesProvider } = await import('@/lib/email/providers');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(sesProvider.send(BASE as any)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
