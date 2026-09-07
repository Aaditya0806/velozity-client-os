import { z } from 'zod';
import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { sendForSignature } from '@/lib/services/signature-requests';
import { uuid } from '@/lib/validation/common';

/**
 * Sends a contract for signature.
 *
 * The most consequential outward action in the product, and fenced accordingly:
 * `contract:send:org` (a different authority from approving it or owning the
 * deal), the contract must already be approved, and an Idempotency-Key is
 * required so a retried send cannot create a second request at the provider.
 */
export const POST = route(
  {
    permission: 'contract:send:org',
    idempotent: true,
    body: z.object({
      contract_id: uuid,
      subject: z.string().max(300).optional(),
      message: z.string().max(5000).optional(),
      expires_in_days: z.number().int().min(1).max(365).optional(),
      provider: z.string().max(40).optional(),
    }),
  },
  async ({ ctx, body, req, db, requestId }) => {
    const result = await db((tx) =>
      sendForSignature(tx, ctx, {
        contractId: body.contract_id,
        subject: body.subject,
        message: body.message,
        expiresInDays: body.expires_in_days,
        provider: body.provider,
        idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
      }),
    );
    return created(result, requestId);
  },
);
