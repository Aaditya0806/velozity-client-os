/**
 * Slack and WhatsApp.
 *
 * Neither can be exercised against a live provider from here. What can be
 * verified is the part this code is responsible for: the request it builds, and
 * how it classifies a failure. The classification is not cosmetic — it decides
 * whether the job queue retries, and retrying a revoked token forever buries the
 * one message that explains the outage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { slackProvider } from '@/lib/integrations/slack';
import { whatsappProvider } from '@/lib/integrations/whatsapp';
import { channelProvider } from '@/lib/integrations';
import { resolveSecret } from '@/lib/integrations/secrets';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('Slack', () => {
  const creds = { token: 'xoxb-test', config: {} };

  it('posts to the channel and returns the message timestamp', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1700000000.000100' }));

    const result = await slackProvider.send(
      { recipient: 'C0123', body: 'A contract expires in 7 days' },
      creds,
    );

    expect(result).toEqual({ providerMessageId: '1700000000.000100', delivered: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    const payload = JSON.parse((init as { body: string }).body);
    expect(payload.channel).toBe('C0123');
    expect(payload.text).toBe('A contract expires in 7 days');
  });

  it('suppresses link previews, so an alert stays one line', () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1.1' }));
    return slackProvider.send({ recipient: 'C1', body: 'x' }, creds).then(() => {
      const payload = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
      expect(payload.unfurl_links).toBe(false);
      expect(payload.unfurl_media).toBe(false);
    });
  });

  it('appends a link to the message body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1.1' }));
    await slackProvider.send(
      { recipient: 'C1', body: 'Renewal due', url: 'https://app.test/legal/renewals' },
      creds,
    );
    const payload = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(payload.text).toBe('Renewal due\nhttps://app.test/legal/renewals');
  });

  it('treats a revoked token as permanent, not transient', async () => {
    // Slack answers HTTP 200 with ok:false, so the status says nothing at all.
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'token_revoked' }));

    await expect(
      slackProvider.send({ recipient: 'C1', body: 'x' }, creds),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('treats a bot that was never invited as permanent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not_in_channel' }));
    await expect(
      slackProvider.send({ recipient: 'C1', body: 'x' }, creds),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('treats an unrecognised error as retryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'ratelimited' }));
    await expect(
      slackProvider.send({ recipient: 'C1', body: 'x' }, creds),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('refuses to send without a token', async () => {
    await expect(
      slackProvider.send({ recipient: 'C1', body: 'x' }, { token: '', config: {} }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WhatsApp', () => {
  const creds = {
    token: 'meta-token',
    config: { phone_number_id: '123456', template_name: 'velozity_alert', template_language: 'en_GB' },
  };

  it('sends the approved template, not free text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.ABC' }] }));

    const result = await whatsappProvider.send(
      { recipient: '+447700900123', body: 'Renewal due' },
      creds,
    );

    expect(result.providerMessageId).toBe('wamid.ABC');
    const payload = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(payload.type).toBe('template');
    expect(payload.template.name).toBe('velozity_alert');
    expect(payload.template.language.code).toBe('en_GB');
    expect(payload.template.components[0].parameters[0].text).toBe('Renewal due');
  });

  it('refuses to send when no template is configured', async () => {
    // The critical case. Free text outside the 24-hour window is *accepted* by
    // the API and never delivered — a success that is not one. Refusing is the
    // only honest behaviour.
    await expect(
      whatsappProvider.send(
        { recipient: '+447700900123', body: 'x' },
        { token: 't', config: { phone_number_id: '1' } },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a number that is not E.164 before calling the API', async () => {
    await expect(
      whatsappProvider.send({ recipient: '07700900123', body: 'x' }, creds),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an expired token as configuration, not a transient fault', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Session expired' } }, 401),
    );
    await expect(
      whatsappProvider.send({ recipient: '+447700900123', body: 'x' }, creds),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('reports a server fault as retryable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'oops' } }, 500));
    await expect(
      whatsappProvider.send({ recipient: '+447700900123', body: 'x' }, creds),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('the provider registry', () => {
  it('resolves the providers that exist', () => {
    expect(channelProvider('slack').name).toBe('slack');
    expect(channelProvider('whatsapp').name).toBe('whatsapp');
  });

  it('refuses one that does not, rather than returning undefined', () => {
    expect(() => channelProvider('telegram')).toThrow(/no channel provider/i);
  });

  it('has no email channel, because email has its own pipeline', () => {
    // Routing email through a "channel" would bypass approval, recording and
    // suppression — three things the email pipeline exists to provide.
    expect(() => channelProvider('email')).toThrow();
    expect(() => channelProvider('gmail')).toThrow();
  });
});

describe('secret resolution', () => {
  it('reads the named environment variable', () => {
    process.env.TEST_SLACK_TOKEN = 'xoxb-from-env';
    expect(resolveSecret('TEST_SLACK_TOKEN', 'Alerts')).toBe('xoxb-from-env');
    delete process.env.TEST_SLACK_TOKEN;
  });

  it('refuses a reference that is not an environment variable name', () => {
    // A ref is never a path or an expression: it names a variable, and nothing
    // it can contain reaches beyond the environment.
    for (const bad of ['../../etc/passwd', 'lower_case', 'A', 'HAS SPACE', '$(whoami)']) {
      expect(() => resolveSecret(bad, 'Alerts')).toThrow();
    }
  });

  it('says which variable is missing rather than failing vaguely', () => {
    expect(() => resolveSecret('DEFINITELY_NOT_SET_ANYWHERE', 'Alerts')).toThrow(
      /DEFINITELY_NOT_SET_ANYWHERE/,
    );
  });

  it('refuses a connection with no secret at all', () => {
    expect(() => resolveSecret(null, 'Alerts')).toThrow(/names no secret/i);
  });
});
