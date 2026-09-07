import { route } from '@/lib/http/api';
import { created } from '@/lib/http/response';
import { createOnboarding, onboardingCreateSchema } from '@/lib/services/onboarding';

export const POST = route(
  { permission: 'onboarding:manage:org', body: onboardingCreateSchema },
  async ({ ctx, body, db, requestId }) => {
    const result = await db((tx) => createOnboarding(tx, ctx, body));
    return created(result, requestId, `/api/v1/onboardings/${result.onboardingId}`);
  },
);
