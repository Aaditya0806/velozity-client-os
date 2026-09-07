import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getTransitionHistory } from '@/lib/services/opportunities';
import { submitForLegalReview, approveContract, voidContract } from '@/lib/services/contracts';
import { contractMachine } from '@/lib/workflows/machines';
import { availableTransitions } from '@/lib/workflows/state-machine';
import { AppError } from '@/lib/http/errors';
import { uuid, transitionBody } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { anyPermission: ['contract:read:own', 'contract:read:team', 'contract:read:org'], params },
  async ({ params: { id }, db, requestId }) => {
    const result = await db(
      async (tx) => {
        const current = await tx.one<{ status: string }>(
          'select status from contracts where id = $1 and deleted_at is null',
          [id],
        );
        return {
          current_status: current.status,
          available: availableTransitions(contractMachine, current.status),
          history: await getTransitionHistory(tx, 'contract', id),
        };
      },
      { readOnly: true },
    );
    return ok(result, requestId);
  },
);

/**
 * Contract transitions are routed to the service that owns each one, because
 * they carry different authorities: review is anyone who can edit the contract,
 * approval needs `contract:approve:org`, voiding needs `contract:void:org`.
 * Sending is not here at all - it has an external effect and lives at
 * POST /api/v1/signature-requests.
 */
export const POST = route(
  {
    anyPermission: ['contract:update:own', 'contract:update:team', 'contract:update:org'],
    params,
    body: transitionBody,
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db(async (tx) => {
      switch (body.to) {
        case 'internal_review':
          return submitForLegalReview(tx, ctx, id);
        case 'approved_to_send':
          return approveContract(tx, ctx, id, body.reason ?? null);
        case 'voided':
          return voidContract(tx, ctx, id, body.reason ?? '');
        case 'sent':
          throw new AppError(
            'INVALID_TRANSITION',
            'Sending a contract has an external effect. Use POST /api/v1/signature-requests.',
          );
        case 'fully_executed':
          throw new AppError(
            'INVALID_TRANSITION',
            'A contract becomes fully executed only through a verified signature webhook.',
          );
        default:
          throw new AppError(
            'INVALID_TRANSITION',
            `"${body.to}" is not a contract transition that can be requested directly.`,
          );
      }
    });
    return ok(result, requestId);
  },
);
