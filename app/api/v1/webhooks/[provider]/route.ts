import { z } from 'zod';
import { NextResponse } from 'next/server';
import { route } from '@/lib/http/api';
import { ingestWebhook } from '@/lib/webhooks/processor';
import { availableProviders } from '@/lib/signature';
import { withService } from '@/lib/db';
import { enqueueJob } from '@/lib/jobs/queue';
import { logger } from '@/lib/util/logger';

const params = z.object({ provider: z.string().max(40) });

/**
 * Inbound provider webhooks.
 *
 * Public by necessity, and therefore careful:
 *   - the raw body is read once and stored *before* anything is interpreted;
 *   - the signature is verified, and an unverified event is recorded and refused
 *     rather than processed;
 *   - processing is queued, not inline, so a slow handler cannot make the
 *     provider time out and retry a storm;
 *   - the response is 202 for anything we accepted, including duplicates, so a
 *     provider never retries an event we already have.
 *
 * A 4xx is returned only for a genuinely unusable request, because a provider
 * that receives a 5xx will keep retrying and a provider that receives a 4xx will
 * usually give up - and giving up on a real signature event is worse.
 */
export const POST = route(
  { public: true, params, rateLimit: false },
  async ({ req, params: { provider }, requestId }) => {
    if (!availableProviders().includes(provider)) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Unknown webhook provider.' }, request_id: requestId },
        { status: 404 },
      );
    }

    const rawBody = Buffer.from(await req.arrayBuffer());

    const result = await ingestWebhook(provider, rawBody, req.headers, requestId);

    if (!result.accepted) {
      // Stored for forensics, never processed.
      return NextResponse.json(
        {
          error: {
            code: 'WEBHOOK_SIGNATURE_INVALID',
            message: 'The webhook signature could not be verified.',
          },
          request_id: requestId,
        },
        { status: 401 },
      );
    }

    if (!result.duplicate) {
      await withService('queue webhook processing', (tx) =>
        enqueueJob(tx, {
          type: 'webhook.process',
          payload: { webhookEventId: result.webhookEventId },
          priority: 10,
          singletonKey: `webhook:${result.webhookEventId}`,
        }),
      );
    }

    logger.info('Webhook accepted', {
      request_id: requestId,
      provider,
      webhook_event_id: result.webhookEventId,
      duplicate: Boolean(result.duplicate),
    });

    return NextResponse.json(
      { received: true, duplicate: Boolean(result.duplicate), request_id: requestId },
      { status: 202 },
    );
  },
);
