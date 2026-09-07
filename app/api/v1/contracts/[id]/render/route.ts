import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { renderContractDocument } from '@/lib/services/contracts';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

/**
 * Renders the contract from its template.
 *
 * A missing required variable fails here with the list of what is missing.
 * The renderer never invents a value and never leaves a placeholder in the
 * output that someone might sign around.
 */
export const POST = route(
  {
    anyPermission: ['contract:update:own', 'contract:update:team', 'contract:update:org'],
    params,
    body: z.object({ variable_values: z.record(z.unknown()).default({}) }),
  },
  async ({ ctx, params: { id }, body, db, requestId }) => {
    const result = await db((tx) =>
      renderContractDocument(tx, ctx, id, body.variable_values),
    );
    return ok(result, requestId);
  },
);
