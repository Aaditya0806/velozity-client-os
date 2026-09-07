import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { getOnboarding } from '@/lib/services/onboarding';
import { uuid } from '@/lib/validation/common';

const params = z.object({ id: uuid });

export const GET = route(
  { permission: 'onboarding:read:org', params },
  async ({ ctx, params: { id }, db, requestId }) => {
    const onboarding = await db((tx) => getOnboarding(tx, ctx, id), { readOnly: true });
    return ok(onboarding, requestId);
  },
);
